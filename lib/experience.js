/**
 * dsh-neural-workflow — 经验生命周期（host 平面）。
 *
 * 学 Veyra 的四个机制，落到一个**追加写**的 NDJSON 账本上：
 *
 *   ① trust 阶梯：`candidate → derived → canonical`。canonical 只能人工确认
 *      （`promote(..., {explicit:true})`）；失败只把 derived 打回 candidate，
 *      canonical 只记历史、不降级。
 *   ② 回流：`feedback()` 把成功/失败应用记进 `applications[]`，成功累计 2 次
 *      自动升 derived——"用过并且有效"才算经验，不是写完就算。
 *   ③ 范围：记录带 `scope{conditions,ranges,units,note}`；矛盾判定要求同 scope。
 *   ④ 复发：共享锚点路径或同一标题前缀的条目跨阈值聚成一组，提示"这个坑又踩了"。
 *
 * 为什么账本只追加：每次 record/feedback/promote 都追加**一条完整快照**，
 * 崩溃只会丢掉最后一截而未写完的行；load 逐行 parse、坏行跳过并计数，
 * 好行照常折出来。历史行永远不被改写，所以降级/升格都可回放。
 *
 * 时间从构造函数注入（`now()`），测试不依赖真实时钟；IO 只读 `node:fs`。
 * 纯 ESM，零第三方依赖。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 允许的经验类型。 */
const KINDS = new Set(['lesson', 'negative', 'idea'])

/** trust 阶梯，从低到高。 */
const STANDINGS = ['candidate', 'derived', 'canonical']

/** 检索加权：trust 越高越该先被看到（与 kb.js 的 severity 加权同一个思路）。 */
const STANDING_WEIGHT = { candidate: 1, derived: 2, canonical: 3 }

/** 成功应用多少次后 candidate 自动升 derived。 */
const SUCCESS_TO_DERIVE = 2

/** 标题相似度阈值（Dice 系数）：低于它就不算"在说同一件事"。 */
const TITLE_SIMILARITY = 0.6

/** 检索默认条数与复发默认阈值。 */
const DEFAULT_LIMIT = 6
const DEFAULT_RECURRENCE = 3

/** 否定词：用于"正文结论相反"的兜底判定。 */
const NEGATION =
  /不|没|未|非|无|别|禁|避免|失败|无效|不能|不要|不可|没有|\b(?:not|no|never|avoid|avoided|fail|failed|fails|without|isn't|don't|doesn't|can't)\b/i

/* ------------------------------------------------------------------ */
/* 纯函数工具                                                          */
/* ------------------------------------------------------------------ */

/** 稳定短哈希：同一工作区路径永远落到同一个 projectKey。 */
export function projectKey(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    throw new TypeError('projectKey 需要一个非空的工作区路径')
  }
  // Windows 路径大小写不敏感，统一小写并统一分隔符，避免同一目录两个账本。
  const resolved = path.resolve(workspacePath).replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

/** 账本路径：`<dshHome>/neural-workflow/projects/<key>/experience.ndjson`。 */
export function storePath(dshHome, workspacePath) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') {
    throw new TypeError('storePath 需要非空的 dshHome')
  }
  return path.join(dshHome, 'neural-workflow', 'projects', projectKey(workspacePath), 'experience.ndjson')
}

/** JSON 深拷贝，避免调用方改到账本内存态。 */
function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

/** 把注入的 now() 归一成 ISO 字符串；非法时间直接报错，不静默变成 1970。 */
function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`now() 返回了非法时间: ${String(value)}`)
  return date.toISOString()
}

/** 范围归一：保留所有自有字段（不丢未知条件），丢弃 undefined。 */
function normalizeScope(scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return {}
  const out = {}
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** 锚点归一：只保留 path 非空的对象，note 一律字符串。 */
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

/** 应用记录归一：只认 success/failure，unknown 丢弃（不猜）。 */
function normalizeApplications(applications) {
  if (!Array.isArray(applications)) return []
  const out = []
  for (const application of applications) {
    if (application === null || typeof application !== 'object') continue
    if (application.outcome !== 'success' && application.outcome !== 'failure') continue
    out.push({
      outcome: application.outcome,
      note: typeof application.note === 'string' ? application.note : '',
      at: typeof application.at === 'string' ? application.at : '',
    })
  }
  return out
}

/** 键序无关的序列化：用来比较两份 scope 是否"同一个范围"。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** scope 签名：同签名才算"同范围"。 */
function scopeKey(scope) {
  return stableStringify(normalizeScope(scope))
}

/** 分词：中文按"字 + 二元组"，英文/数字按词（与 kb.js 同一套口径）。 */
function tokenize(text) {
  const raw = typeof text === 'string' ? text.toLowerCase() : ''
  const tokens = new Set()
  for (const word of raw.match(/[a-z0-9_#.-]{2,}/g) ?? []) tokens.add(word)
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.add(run[index])
      if (index + 1 < run.length) tokens.add(run.slice(index, index + 2))
    }
  }
  return tokens
}

/** 标题相似度：Dice 系数，至少共享一个词项才可能相似。 */
function titleSimilarity(left, right) {
  const a = tokenize(left)
  const b = tokenize(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const term of a) if (b.has(term)) shared += 1
  if (shared === 0) return 0
  return (2 * shared) / (a.size + b.size)
}

/**
 * 标题前缀：中文取开头两字，英文/数字取首个词。
 * 用来做复发聚类的 "同一个起点" 签名（如 OOM / loss / 大模）。
 */
function titlePrefix(title) {
  const raw = typeof title === 'string' ? title.trim().toLowerCase() : ''
  if (raw === '') return ''
  const lead = raw.split(/[\s：:，,。.;；\-—|/()（）[\]【】]+/u)[0] ?? ''
  if (lead === '') return ''
  const cjk = lead.match(/^[\u4e00-\u9fff]+/u)
  if (cjk) return cjk[0].slice(0, 2)
  const word = lead.match(/^[a-z0-9_#.-]+/u)
  return word !== null && word[0].length >= 2 ? word[0] : ''
}

/** 正文是否含否定词：kind 对不上时用它兜底判定"结论相反"。 */
function hasNegation(body) {
  return typeof body === 'string' && NEGATION.test(body)
}

/** 两条记录是否结论相反：kind 一 lesson 一 negative，或正文否定性不同。 */
function opposing(left, right) {
  const kindPair =
    (left.kind === 'lesson' && right.kind === 'negative') || (left.kind === 'negative' && right.kind === 'lesson')
  if (kindPair) return true
  return hasNegation(left.body) !== hasNegation(right.body)
}

/* ------------------------------------------------------------------ */
/* 追加写 IO                                                           */
/* ------------------------------------------------------------------ */

/**
 * 追加一行 JSON。崩溃安全的两点：
 *   ① 先 mkdir -p，目录不存在时也能第一次写入；
 *   ② 若文件尾不是换行（上次崩溃留下半行），先补一个换行，避免新行被粘到坏行上。
 */
function appendLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let prefix = ''
  try {
    const size = fs.statSync(file).size
    if (size > 0) {
      const fd = fs.openSync(file, 'r')
      try {
        const last = Buffer.alloc(1)
        fs.readSync(fd, last, 0, 1, size - 1)
        if (last[0] !== 0x0a) prefix = '\n'
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ */
/* 折账：一行 = 一条完整快照，按 id 合并                                */
/* ------------------------------------------------------------------ */

/** 把一行解析结果归一成记录；不可恢复的坏行由 load 负责计数跳过。 */
function normalizeStored(raw) {
  const record = {
    id: raw.id.trim(),
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    kind: KINDS.has(raw.kind) ? raw.kind : 'lesson',
    scope: normalizeScope(raw.scope),
    anchors: normalizeAnchors(raw.anchors),
    standing: STANDINGS.includes(raw.standing) ? raw.standing : 'candidate',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    applications: normalizeApplications(raw.applications),
  }
  if (raw.sourceEvent !== undefined) record.sourceEvent = raw.sourceEvent
  return record
}

/** 应用历史合并：next 若已覆盖 previous 全集就采信 next，否则补上缺失尾部。 */
function mergeApplications(previous, next) {
  if (next.length === 0) return previous
  const remaining = [...next]
  let covered = true
  for (const application of previous) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.outcome === application.outcome &&
        candidate.at === application.at &&
        candidate.note === application.note,
    )
    if (index < 0) {
      covered = false
      break
    }
    remaining.splice(index, 1)
  }
  if (covered) return next
  return [...previous, ...remaining]
}

/**
 * 同一 id 的多行合并。快照总是完整的，但手写/截断的行可能只带部分字段：
 * scope 浅合并、applications 保历史、anchors/title/body 缺失时保留旧值。
 */
function mergeRecord(previous, next) {
  const merged = {
    id: previous.id,
    title: next.title !== '' ? next.title : previous.title,
    body: next.body !== '' ? next.body : previous.body,
    kind: next.kind,
    scope: { ...previous.scope, ...next.scope },
    anchors: next.anchors.length > 0 ? next.anchors : previous.anchors,
    standing: next.standing,
    createdAt: previous.createdAt !== '' ? previous.createdAt : next.createdAt,
    applications: mergeApplications(previous.applications, next.applications),
  }
  const sourceEvent = next.sourceEvent ?? previous.sourceEvent
  if (sourceEvent !== undefined) merged.sourceEvent = sourceEvent
  return merged
}

/* ------------------------------------------------------------------ */
/* 经验账本                                                            */
/* ------------------------------------------------------------------ */

export class ExperienceStore {
  /**
   * @param {{ file: string, now?: () => Date|number|string }} options
   *   file：NDJSON 账本路径（由 storePath 算）；now：时间注入，默认真实时钟。
   */
  constructor({ file, now } = {}) {
    if (typeof file !== 'string' || file.trim() === '') {
      throw new TypeError('ExperienceStore 需要非空的 file 路径')
    }
    if (now !== undefined && typeof now !== 'function') {
      throw new TypeError('ExperienceStore 的 now 必须是函数')
    }
    this.file = file
    this.now = now ?? (() => new Date())
    this.records = new Map()
    this.skipped = 0
    this.loaded = false
    this.counter = 0
  }

  /** 首次访问时懒加载；显式调用 load() 也会重新读盘（幂等，重置计数）。 */
  #ensureLoaded() {
    if (!this.loaded) this.load()
  }

  /**
   * 逐行读账本并折出当前状态。坏行（非 JSON / 非对象 / 无 id）跳过并计数，
   * **不抛**——账本损坏不该让整个插件起不来。返回 `{loaded, skipped}`。
   */
  load() {
    this.records = new Map()
    this.skipped = 0

    let text = ''
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.loaded = true
      return { loaded: 0, skipped: 0 }
    }

    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        this.skipped += 1
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.skipped += 1
        continue
      }
      if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
        this.skipped += 1
        continue
      }
      const record = normalizeStored(parsed)
      const previous = this.records.get(record.id)
      this.records.set(record.id, previous === undefined ? record : mergeRecord(previous, record))
    }

    this.loaded = true
    return { loaded: this.records.size, skipped: this.skipped }
  }

  /** 全量快照副本，按账本出现顺序。 */
  all() {
    this.#ensureLoaded()
    return [...this.records.values()].map(clone)
  }

  /** 生成一个不与现有记录冲突的短 id。 */
  #nextId(title, body, at) {
    let attempt = 0
    for (;;) {
      const digest = crypto
        .createHash('sha256')
        .update(`${title}\u0000${body}\u0000${at}\u0000${this.counter}\u0000${attempt}`)
        .digest('hex')
      const id = `exp-${digest.slice(0, 12)}`
      this.counter += 1
      if (!this.records.has(id)) return id
      attempt += 1
    }
  }

  /**
   * 记一条新经验，standing 默认 candidate。
   * @returns 写入后的记录（含 id / createdAt / applications）。
   */
  record(input = {}) {
    this.#ensureLoaded()
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new TypeError('record 需要非空的 title')
    if (!KINDS.has(input.kind)) throw new RangeError(`未知经验类型: ${String(input.kind)}`)
    const body = input.body === undefined ? '' : input.body
    if (typeof body !== 'string') throw new TypeError('record 的 body 必须是字符串')

    const at = toIso(this.now())
    const record = {
      id: this.#nextId(title, body, at),
      title,
      body,
      kind: input.kind,
      scope: normalizeScope(input.scope),
      anchors: normalizeAnchors(input.anchors),
      standing: 'candidate',
      createdAt: at,
      applications: [],
    }
    if (input.sourceEvent !== undefined) record.sourceEvent = input.sourceEvent

    appendLine(this.file, record)
    this.records.set(record.id, record)
    return clone(record)
  }

  /**
   * 记一次应用回流。
   * - success 累计 ≥2 次且当前 candidate → derived；
   * - failure 把 derived 降回 candidate；
   * - canonical 只记历史，不降级；
   * - 未知 id 抛错（不静默吞掉一次反馈）。
   */
  feedback(id, outcome, note = '') {
    this.#ensureLoaded()
    if (outcome !== 'success' && outcome !== 'failure') {
      throw new RangeError(`未知反馈结果: ${String(outcome)}（只接受 success / failure）`)
    }
    const current = this.records.get(id)
    if (current === undefined) throw new Error(`未知经验 id: ${String(id)}`)

    const application = {
      outcome,
      note: typeof note === 'string' ? note.trim() : String(note ?? ''),
      at: toIso(this.now()),
    }
    const applications = [...current.applications, application]
    const updated = { ...current, applications, standing: nextStanding(current.standing, applications, outcome) }

    appendLine(this.file, updated)
    this.records.set(id, updated)
    return clone(updated)
  }

  /**
   * 人工升格。升 canonical 必须 `explicit: true`（人工确认），否则抛错；
   * promote 只往上走，canonical 降级只走 feedback(failure)。
   */
  promote(id, to, options = {}) {
    this.#ensureLoaded()
    if (to !== 'derived' && to !== 'canonical') {
      throw new RangeError(`未知目标 standing: ${String(to)}（只接受 derived / canonical）`)
    }
    const current = this.records.get(id)
    if (current === undefined) throw new Error(`未知经验 id: ${String(id)}`)
    if (to === 'canonical' && options.explicit !== true) {
      throw new Error('升 canonical 必须传 { explicit: true }：canonical 只能人工确认')
    }
    if (current.standing === 'canonical' && to === 'derived') {
      throw new Error('promote 不能把 canonical 降回 derived；降级只走 feedback(failure)')
    }
    if (current.standing === to) return clone(current)

    const updated = { ...current, standing: to }
    appendLine(this.file, updated)
    this.records.set(id, updated)
    return clone(updated)
  }

  /** 检索：词项命中打分（标题 3、正文 1、短语 2），trust 越高加权越大。 */
  search(query, limit = DEFAULT_LIMIT) {
    this.#ensureLoaded()
    const terms = tokenize(query)
    if (terms.size === 0) return []

    const scored = []
    for (const record of this.records.values()) {
      const titleTokens = tokenize(record.title)
      const bodyTokens = tokenize(record.body)
      const lowerTitle = record.title.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (titleTokens.has(term)) score += 3
        else if (bodyTokens.has(term)) score += 1
        if (term.length >= 2 && lowerTitle.includes(term)) score += 2
      }
      if (score <= 0) continue
      score *= STANDING_WEIGHT[record.standing] ?? 1
      scored.push({
        id: record.id,
        title: record.title,
        kind: record.kind,
        standing: record.standing,
        score,
        scope: clone(record.scope),
      })
    }

    scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    const parsed = Number(limit)
    const size = Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : DEFAULT_LIMIT
    return scored.slice(0, size)
  }

  /**
   * 矛盾：同 scope、标题高相似、结论相反 → `[[aId, bId], ...]`。
   * 只列出，**不合并、不改 standing**——两方都保持可见，由人裁决。
   */
  contradictions() {
    this.#ensureLoaded()
    const records = [...this.records.values()]
    const pairs = []
    for (let left = 0; left < records.length; left += 1) {
      for (let right = left + 1; right < records.length; right += 1) {
        const a = records[left]
        const b = records[right]
        if (scopeKey(a.scope) !== scopeKey(b.scope)) continue
        if (titleSimilarity(a.title, b.title) < TITLE_SIMILARITY) continue
        if (!opposing(a, b)) continue
        pairs.push([a.id, b.id].sort())
      }
    }
    return pairs
  }

  /**
   * 复发：共享 `anchors[].path` 或同一标题前缀的记录聚成簇，
   * 只返回 size ≥ threshold 的簇。阈值可配（默认 3）。
   */
  recurrence(threshold = DEFAULT_RECURRENCE) {
    this.#ensureLoaded()
    const parsed = Number(threshold)
    const size = Number.isFinite(parsed) ? Math.max(2, Math.trunc(parsed)) : DEFAULT_RECURRENCE

    const clusters = new Map()
    const add = (signature, id) => {
      const ids = clusters.get(signature)
      if (ids === undefined) clusters.set(signature, [id])
      else if (!ids.includes(id)) ids.push(id)
    }
    for (const record of this.records.values()) {
      for (const anchor of record.anchors) add(`anchor:${anchor.path}`, record.id)
      const prefix = titlePrefix(record.title)
      if (prefix !== '') add(`title:${prefix}`, record.id)
    }

    const seen = new Set()
    const result = []
    for (const [signature, ids] of clusters) {
      if (ids.length < size) continue
      // 同一组 id 可能同时被锚点和标题前缀命中：只保留先出现的签名（锚点更具体）。
      const key = ids.join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ signature, ids: [...ids] })
    }
    result.sort((left, right) => right.ids.length - left.ids.length || left.signature.localeCompare(right.signature))
    return result
  }
}

/** 反馈之后的 standing：canonical 冻结，failure 降一级，success 累计够数才升。 */
function nextStanding(standing, applications, outcome) {
  if (standing === 'canonical') return standing
  if (outcome === 'failure') return standing === 'derived' ? 'candidate' : standing
  const successes = applications.filter((application) => application.outcome === 'success').length
  if (standing === 'candidate' && successes >= SUCCESS_TO_DERIVE) return 'derived'
  return standing
}
