/**
 * dsh-neural-workflow — 跨会话项目状态（claim-evidence map + run 登记）。
 *
 * 与 experience.js 的账本不同，状态是**小而整**的单文件 JSON（state.json），
 * 所以持久化走**原子写**：先写 `<file>.tmp` 再 rename 覆盖——rename 在同一目录
 * 内是原子的，崩溃最坏留下一个废弃 tmp，state.json 要么是旧态要么是新态，
 * 不会出现写了一半的混合态。
 *
 * 两张图：
 *   ① claim-evidence map：声明（"节点 X 完成"）+ 证据（gate/test/…）。
 *      证据里只要有一条 kind !== 'failure' 的条目，声明就从 open 变 supported；
 *      failure 证据**只记录不支撑**——失败的事实要落账，但失败不是证据。
 *   ② run 登记：recordRun 开一条 running 的运行，finishRun 用终态关账，
 *      progress 可选（executor 的 {satisfied,total} 口径）。
 *
 * 时间从构造函数注入（`now()`），测试不依赖真实时钟；load 容错：
 * 坏 JSON 返回空态并记 skipped，**不抛**——状态文件损坏不该让插件起不来，
 * 下一次写入会用干净的新状态覆盖它。
 * 纯 ESM，零第三方依赖，只用 node:fs / node:path / node:crypto。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 运行状态全集；finishRun 只接受终态。 */
const RUN_STATUSES = new Set(['running', 'ok', 'failed'])
const TERMINAL_RUN_STATUSES = new Set(['ok', 'failed'])

/* ------------------------------------------------------------------ */
/* 纯函数工具                                                          */
/* ------------------------------------------------------------------ */

/**
 * 稳定短哈希：与 lib/experience.js 的 projectKey **必须保持同一算法**，
 * 这样同一工作区的经验账本和项目状态落在同一个 project 目录。
 * （本模块刻意自包含，不从 experience.js import，保持零内部依赖。）
 */
export function projectKey(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    throw new TypeError('projectKey 需要一个非空的工作区路径')
  }
  // Windows 路径大小写不敏感，统一小写并统一分隔符，避免同一目录两套状态。
  const resolved = path.resolve(workspacePath).replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

/** 状态文件路径：`<dshHome>/neural-workflow/projects/<projectKey>/state.json`。 */
export function projectStatePath(dshHome, workspace) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') {
    throw new TypeError('projectStatePath 需要非空的 dshHome')
  }
  return path.join(dshHome, 'neural-workflow', 'projects', projectKey(workspace), 'state.json')
}

/** JSON 深拷贝，避免调用方改到内存态。 */
function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

/** 把注入的 now() 归一成 ISO 字符串；非法时间直接报错，不静默变成 1970。 */
function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`now() 返回了非法时间: ${String(value)}`)
  return date.toISOString()
}

/** 锚点归一：只保留 path 非空的对象，note 一律字符串（与 experience.js 同一口径）。 */
function normalizeAnchors(anchors) {
  if (!Array.isArray(anchors)) return []
  const out = []
  for (const anchor of anchors) {
    if (anchor === null || typeof anchor !== 'object') continue
    const anchorPath = typeof anchor.path === 'string' ? anchor.path.trim() : ''
    if (anchorPath === '') continue
    out.push({ path: anchorPath, note: typeof anchor.note === 'string' ? anchor.note.trim() : '' })
  }
  return out
}

/**
 * 证据归一：node 与 kind 必须是非空字符串（证据必须能定位到节点与类型），
 * at 缺省用注入时钟补；note/anchors 可选。
 */
function normalizeEvidence(evidence, fallbackAt) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('evidence 必须是对象')
  }
  const node = typeof evidence.node === 'string' ? evidence.node.trim() : ''
  const kind = typeof evidence.kind === 'string' ? evidence.kind.trim() : ''
  if (node === '') throw new TypeError('evidence 需要非空的 node')
  if (kind === '') throw new TypeError('evidence 需要非空的 kind')
  return {
    at: evidence.at !== undefined ? toIso(evidence.at) : fallbackAt,
    node,
    kind,
    note: typeof evidence.note === 'string' ? evidence.note : '',
    anchors: normalizeAnchors(evidence.anchors),
  }
}

/** 证据里是否存在"非 failure"的条目：有就算支撑（failure 只记录不支撑）。 */
function isSupported(evidence) {
  return evidence.some((entry) => entry.kind !== 'failure')
}

/** progress 归一：executor 的 {satisfied,total} 口径；必须是对象或省略。 */
function normalizeProgress(progress) {
  if (progress === undefined) return undefined
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) {
    throw new TypeError('progress 必须是对象（如 {satisfied,total}）')
  }
  return clone(progress)
}

/* ------------------------------------------------------------------ */
/* 折盘：一行状态文件 = 全量快照                                        */
/* ------------------------------------------------------------------ */

/** 归一一条从盘上读到的 claim；没有有效 id 的条目返回 null 由 load 计数跳过。 */
function normalizeStoredClaim(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  const evidence = []
  for (const entry of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const node = typeof entry.node === 'string' ? entry.node.trim() : ''
    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : ''
    if (node === '' || kind === '') continue
    evidence.push({
      at: typeof entry.at === 'string' ? entry.at : '',
      node,
      kind,
      note: typeof entry.note === 'string' ? entry.note : '',
      anchors: normalizeAnchors(entry.anchors),
    })
  }
  return {
    id: raw.id.trim(),
    text: typeof raw.text === 'string' ? raw.text : '',
    node: typeof raw.node === 'string' ? raw.node : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    evidence,
    status: raw.status === 'supported' ? 'supported' : 'open',
  }
}

/** 归一一条从盘上读到的 run；没有有效 id 的条目返回 null 由 load 计数跳过。 */
function normalizeStoredRun(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  const run = {
    id: raw.id.trim(),
    node: typeof raw.node === 'string' ? raw.node : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    status: RUN_STATUSES.has(raw.status) ? raw.status : 'running',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
  }
  if (raw.finishedAt !== undefined && typeof raw.finishedAt === 'string') run.finishedAt = raw.finishedAt
  if (raw.progress !== undefined && raw.progress !== null && typeof raw.progress === 'object' && !Array.isArray(raw.progress)) {
    run.progress = clone(raw.progress)
  }
  return run
}

/* ------------------------------------------------------------------ */
/* 项目状态                                                            */
/* ------------------------------------------------------------------ */

export class ProjectState {
  /**
   * @param {{ file: string, now?: () => Date|number|string }} options
   *   file：state.json 路径（由 projectStatePath 算）；now：时间注入，默认真实时钟。
   */
  constructor({ file, now } = {}) {
    if (typeof file !== 'string' || file.trim() === '') {
      throw new TypeError('ProjectState 需要非空的 file 路径')
    }
    if (now !== undefined && typeof now !== 'function') {
      throw new TypeError('ProjectState 的 now 必须是函数')
    }
    this.file = file
    this.now = now ?? (() => new Date())
    this.claimsMap = new Map()
    this.runsMap = new Map()
    this.skipped = 0
    this.loaded = false
    this.nextClaim = 0
    this.nextRun = 0
  }

  /** 首次访问时懒加载；显式调用 load() 也会重新读盘（幂等，重置计数）。 */
  #ensureLoaded() {
    if (!this.loaded) this.load()
  }

  /**
   * 读状态文件并折出当前态。坏 JSON / 非对象返回空态并记 skipped，**不抛**。
   * 返回 `{loaded, skipped}`（loaded = 有效 claim + run 条数）。
   */
  load() {
    this.claimsMap = new Map()
    this.runsMap = new Map()
    this.skipped = 0
    this.nextClaim = 0
    this.nextRun = 0

    let text = ''
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.loaded = true
      return { loaded: 0, skipped: 0 }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      this.skipped = 1
      this.loaded = true
      return { loaded: 0, skipped: 1 }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.skipped = 1
      this.loaded = true
      return { loaded: 0, skipped: 1 }
    }

    let loaded = 0
    for (const raw of Array.isArray(parsed.claims) ? parsed.claims : []) {
      const claim = normalizeStoredClaim(raw)
      if (claim === null) {
        this.skipped += 1
        continue
      }
      this.claimsMap.set(claim.id, claim)
      const seq = /^claim-(\d+)$/.exec(claim.id)
      if (seq) this.nextClaim = Math.max(this.nextClaim, Number(seq[1]))
      loaded += 1
    }
    for (const raw of Array.isArray(parsed.runs) ? parsed.runs : []) {
      const run = normalizeStoredRun(raw)
      if (run === null) {
        this.skipped += 1
        continue
      }
      this.runsMap.set(run.id, run)
      const seq = /^run-(\d+)$/.exec(run.id)
      if (seq) this.nextRun = Math.max(this.nextRun, Number(seq[1]))
      loaded += 1
    }
    // 计数器显式持久化，避免手写条目 id 不带序号时新 id 撞旧 id。
    const counters = parsed.counters ?? {}
    if (Number.isFinite(counters.claim)) this.nextClaim = Math.max(this.nextClaim, Number(counters.claim))
    if (Number.isFinite(counters.run)) this.nextRun = Math.max(this.nextRun, Number(counters.run))

    this.loaded = true
    return { loaded, skipped: this.skipped }
  }

  /**
   * 原子写全量快照：先写 `<file>.tmp` 再 rename 覆盖。
   * 同目录 rename 保证 state.json 要么旧态要么新态，tmp 残留无害。
   */
  #save() {
    const state = {
      version: 1,
      claims: [...this.claimsMap.values()],
      runs: [...this.runsMap.values()],
      counters: { claim: this.nextClaim, run: this.nextRun },
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
  }

  /** 全量 claim 快照副本，按登记顺序。 */
  claims() {
    this.#ensureLoaded()
    return [...this.claimsMap.values()].map(clone)
  }

  /** 全量 run 快照副本，按登记顺序。 */
  runs() {
    this.#ensureLoaded()
    return [...this.runsMap.values()].map(clone)
  }

  /**
   * 登记一条新声明，status 默认 open、evidence 为空。
   * @returns 写入后的 claim（含 id / createdAt）。
   */
  addClaim({ text, node } = {}) {
    this.#ensureLoaded()
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') throw new TypeError('addClaim 需要非空的 text')
    const claimNode = typeof node === 'string' ? node.trim() : ''
    if (claimNode === '') throw new TypeError('addClaim 需要非空的 node')

    this.nextClaim += 1
    const claim = {
      id: `claim-${this.nextClaim}`,
      text: trimmed,
      node: claimNode,
      createdAt: toIso(this.now()),
      evidence: [],
      status: 'open',
    }
    this.claimsMap.set(claim.id, claim)
    this.#save()
    return clone(claim)
  }

  /**
   * 给声明挂一条证据；证据里出现 kind !== 'failure' 的条目即转 supported。
   * failure 证据照记（失败要落账），但绝不让声明变 supported。
   * @returns 更新后的 claim。
   */
  linkEvidence(claimId, evidence = {}) {
    this.#ensureLoaded()
    const claim = this.claimsMap.get(claimId)
    if (claim === undefined) throw new Error(`未知 claim id: ${claimId}`)
    claim.evidence.push(normalizeEvidence(evidence, toIso(this.now())))
    if (claim.status !== 'supported' && isSupported(claim.evidence)) claim.status = 'supported'
    this.#save()
    return clone(claim)
  }

  /**
   * 登记一次运行，status 默认 running。
   * @returns 写入后的 run（含 id / startedAt）。
   */
  recordRun({ node, sessionId, status, progress } = {}) {
    this.#ensureLoaded()
    if (status !== undefined && !RUN_STATUSES.has(status)) {
      throw new RangeError(`未知 run 状态: ${String(status)}`)
    }
    const runNode = typeof node === 'string' ? node.trim() : ''
    if (runNode === '') throw new TypeError('recordRun 需要非空的 node')
    const session = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (session === '') throw new TypeError('recordRun 需要非空的 sessionId')

    this.nextRun += 1
    const run = {
      id: `run-${this.nextRun}`,
      node: runNode,
      sessionId: session,
      status: status ?? 'running',
      startedAt: toIso(this.now()),
    }
    const normalized = normalizeProgress(progress)
    if (normalized !== undefined) run.progress = normalized
    this.runsMap.set(run.id, run)
    this.#save()
    return clone(run)
  }

  /**
   * 用终态关账：status 只接受 ok/failed，finishedAt 记当前注入时间；
   * progress 省略时保留登记时的值。未知 runId 抛错，不静默吞掉。
   * @returns 更新后的 run。
   */
  finishRun(runId, { status, progress } = {}) {
    this.#ensureLoaded()
    const run = this.runsMap.get(runId)
    if (run === undefined) throw new Error(`未知 run id: ${runId}`)
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      throw new RangeError(`finishRun 只接受终态 ok|failed，收到: ${String(status)}`)
    }
    run.status = status
    run.finishedAt = toIso(this.now())
    const normalized = normalizeProgress(progress)
    if (normalized !== undefined) run.progress = normalized
    this.#save()
    return clone(run)
  }
}
