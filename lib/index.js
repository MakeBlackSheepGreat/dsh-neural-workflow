/**
 * dsh-neural-workflow —— 宿主半。
 *
 * 只做四件事，都是**进程级、只做一次**的：
 *   ① 注册会话投影单元：账本不是被存下来的，而是**会话日志的投影**
 *      （学 clearAI `host.js` 的正形：状态只有一个权威，`fold.js` 的 `applyEvent`）。
 *   ② 把**约束判定**交给 Rust 中间件 `nw-constrain`（学 dsh-ops 的正形：原生 worker 走
 *      受管子进程，宿主只做 I/O 与降级，不在 JS 里重算——第二套解释器必然漂移）。
 *   ③ 挂 `systemPrompt` 段落：把"当前前沿与违规"作为运行时上下文交给模型。
 *   ④ 提供 `neural_flow` 工具：模型在工作流上落证据，落账前先被判一次。
 *
 * 面板 HTTP 面挂在 connection 的 exact fetch route 表上（不是 `webServer`）——
 * 挂错层，浏览器里一按就是 404。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { CONSTRAINT_DOC } from './constraints.js'
import { GRAPH_DOC } from './graph.js'
import { brief, renderBrief } from './brief.js'
import { DETAIL, TIMELINE, applyEvent, foldEvents } from './fold.js'
import * as kb from './kb.js'
import { FAILURE_KIND, validateEvidence } from './vocab.js'
import { Budget, planStep, resolveBudget } from './executor.js'
import { ExperienceStore, projectKey, storePath } from './experience.js'
import { ProjectState, projectStatePath } from './project-state.js'
import { Backflow } from './backflow.js'
import { join as pathJoin } from 'node:path'

export const name = 'neural-workflow'

/** 宿主服务：投影注册表 + 会话存储 + 工具注册表 + 系统提示词注册表。 */
export const inject = ['sessionProjections', 'sessions', 'tools', 'systemPrompt']

const BINARY = process.platform === 'win32' ? 'nw-constrain.exe' : 'nw-constrain'

/** 本包根目录（`lib/index.js` 与 `src/index.js` 两种布局都正确）。 */
function packageRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** 图里的节点对象（找不到返回 undefined，不猜）。 */
function nodeOf(id) {
  if (typeof id !== 'string' || id === '') return undefined
  return (GRAPH_DOC.nodes ?? []).find((node) => node.id === id)
}

/**
 * 工具输出必须能无损过 JSON（宿主会拒收含函数/环/BigInt 的值）。
 * 子代理的 result 形状不受我们控制，所以出口处统一消毒：
 * 字符串截断；可序列化对象原样；其余降级为字符串摘要——**不丢事实，也不假装无损**。
 */
function lossless(value, limit = 4000) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.slice(0, limit)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value).slice(0, limit)
  }
}

/**
 * 位置解析：`<DSH_HOME>/neural-workflow/projects/<key>/`。
 *
 * 刻意**不写进用户仓库**（学 Veyra：记忆在 `$DSH_HOME/veyra/` 下）。项目隔离靠
 * `projectKey(workspace)`：同一目录永远同一个 key，不同项目互不可见。
 */
function resolveHomeWorkspace(ctx, sessionId, sessionOf) {
  let dshHome
  try {
    const joinHome = ctx.get('dshHomePath')
    if (typeof joinHome === 'function') dshHome = joinHome()
  } catch {
    dshHome = undefined
  }
  if (typeof dshHome !== 'string' || dshHome === '') {
    dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.dsh`
  }
  let workspace
  try {
    const session = sessionOf(sessionId)
    workspace = session?.header?.cwd
  } catch {
    workspace = undefined
  }
  if (typeof workspace !== 'string' || workspace === '') workspace = process.cwd()
  return { dshHome, workspace }
}

function resolveStore(ctx, sessionId, sessionOf) {
  const { dshHome, workspace } = resolveHomeWorkspace(ctx, sessionId, sessionOf)
  return new ExperienceStore({ file: storePath(dshHome, workspace) })
}

/** 跨会话项目状态：claim-evidence map + run 登记（与经验账本同目录）。 */
function resolveState(ctx, sessionId, sessionOf) {
  const { dshHome, workspace } = resolveHomeWorkspace(ctx, sessionId, sessionOf)
  return new ProjectState({ file: projectStatePath(dshHome, workspace) })
}

/**
 * skill 目录解析（经验回流用）。只找，不创建：
 * config.skillDir → 环境变量 → 工作区内 → 本包同级的研究仓库。
 */
function resolveSkillDir(ctx, sessionId, sessionOf, config) {
  const candidates = []
  if (typeof config?.skillDir === 'string' && config.skillDir.trim() !== '') candidates.push(config.skillDir.trim())
  if (typeof process.env.NEURAL_PAPER_SKILL === 'string' && process.env.NEURAL_PAPER_SKILL.trim() !== '') candidates.push(process.env.NEURAL_PAPER_SKILL.trim())
  const { workspace } = resolveHomeWorkspace(ctx, sessionId, sessionOf)
  candidates.push(pathJoin(workspace, 'skills', 'neural-paper-workflow'))
  candidates.push(pathJoin(packageRoot(), '..', 'Neural_Paper_Skill', 'skills', 'neural-paper-workflow'))
  for (const candidate of candidates) {
    try {
      if (existsSync(pathJoin(candidate, 'knowledge', 'graph'))) return candidate
    } catch {
      /* 不可读就试下一个候选 */
    }
  }
  return undefined
}

function resolveBackflow(ctx, sessionId, sessionOf, config) {
  const skill = resolveSkillDir(ctx, sessionId, sessionOf, config)
  if (skill === undefined) return undefined
  return new Backflow({
    draftsDir: pathJoin(skill, 'knowledge', 'drafts'),
    graphDir: pathJoin(skill, 'knowledge', 'graph'),
  })
}

/** 找到二进制；找不到返回 undefined（**不用 JS 兜底**——降级要说真话）。 */
function locateBinary(configured) {
  const root = packageRoot()
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  candidates.push(`${root}runtime/${process.platform}-${process.arch}/${BINARY}`)
  candidates.push(`${root}native/bin/${BINARY}`)
  candidates.push(`${root}lib/native/${BINARY}`)
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 不可读就当没有这一个候选 */
    }
  }
  return undefined
}

/**
 * 中间件客户端：一次一个请求、逐行 JSON。
 * 超时或崩溃 → 本次判定降级；下一次请求允许重启一次（瞬时失败不该永久关灯）。
 */
class Middleware {
  constructor({ binary, timeoutMs, report }) {
    this.binary = binary
    this.timeoutMs = timeoutMs
    this.report = report
    this.child = undefined
    this.pending = new Map()
    this.sequence = 0
    this.failure = undefined
    this.disposed = false
    this.restarted = false
  }

  get degraded() {
    return this.binary === undefined || this.failure !== undefined
  }

  start() {
    if (this.binary === undefined || this.disposed || this.child !== undefined) return
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() === '') return
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      const waiting = this.pending.get(String(payload?.id))
      if (waiting === undefined) return
      this.pending.delete(String(payload.id))
      clearTimeout(waiting.timer)
      waiting.resolve(payload)
    })

    createInterface({ input: child.stderr }).on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed !== '') this.report(`neural-workflow: ${trimmed}`, 'info')
    })

    const failAll = (reason) => {
      this.child = undefined
      this.failure = reason
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer)
        this.pending.delete(id)
        waiting.resolve({ id, ok: false, error: { code: 'E_WORKER', message: reason } })
      }
    }
    child.on('error', (error) => failAll(`无法启动 nw-constrain：${error.message}`))
    child.on('exit', (code) => {
      if (this.disposed) return
      failAll(`nw-constrain 退出（code ${code}）`)
    })
  }

  async request(op, input) {
    if (this.binary === undefined) {
      return { ok: false, error: { code: 'E_NO_BINARY', message: '未找到 nw-constrain 二进制' } }
    }
    if (this.failure !== undefined && !this.restarted) {
      this.failure = undefined
      this.restarted = true
    }
    this.start()
    const child = this.child
    if (child === undefined) {
      return { ok: false, error: { code: 'E_WORKER', message: this.failure ?? 'worker 不可用' } }
    }
    const id = String(++this.sequence)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ id, ok: false, error: { code: 'E_TIMEOUT', message: `nw-constrain 超时（${this.timeoutMs}ms）` } })
      }, this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, op, input })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ id, ok: false, error: { code: 'E_STDIN', message: String(error?.message ?? error) } })
      }
    })
  }

  stop() {
    this.disposed = true
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      /* 关不上就算了 */
    }
  }
}

/** 读一段请求体（有上限）。 */
async function readJsonBody(request, limit = 256 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

/**
 * 极简 schema 校验（投影的 stateSchema / viewSchema 只要"能不能序列化"这一条契约）。
 * 依赖 zod 会多一个 peer；这里用等价的最小实现，行为对得上"必须通过"。
 */
const passthrough = (label) => ({
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
  _label: label,
})

function applyCore(ctx, config = {}) {
  const eventsLimit = Number.isFinite(config.eventsLimit) ? Math.max(0, Math.trunc(config.eventsLimit)) : 5000
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(200, Math.trunc(config.timeoutMs)) : 5000
  const contextOrder = Number.isFinite(config.contextOrder) ? Math.trunc(config.contextOrder) : 900

  const report = (message, level = 'error') => {
    const logger = ctx?.logger
    const sink = logger === undefined ? undefined : Reflect.get(logger, level)
    if (typeof sink === 'function') sink.call(logger, message)
    else if (level === 'warn') console.warn(message)
    else console.error(message)
  }

  const binary = locateBinary(config.binaryPath)
  const worker = new Middleware({ binary, timeoutMs, report })
  if (binary === undefined) {
    report(`neural-workflow: 未找到 nw-constrain（${BINARY}）；面板进入只读降级，不做 JS 兜底判定`, 'warn')
  }

  ctx.effect(() => () => worker.stop(), 'neural-workflow: middleware worker')

  /**
   * 可选：把 C1–C6 交给宿主的**不变量诊断面**（学 clearAI `invariant.js`）。
   *
   * clearAI 的写法是 `invariants.register(包名, installFn)`，且**只在服务存在时**注册——
   * 不变量不是每个部署都挂（它由组合决定，还带包名白/黑名单）。
   * 没挂时这段是零成本的一次判断，不是一个永远等服务的悬空行。
   *
   * 诚实标注：本机部署里没有 `invariants` 服务（`Service.listService` 查不到），
   * 所以这条路径**未经实测**；它失败只记一条日志，绝不把产品弄坏。
   * 是否真的挂上，看 `/api/neural-workflow/selftest` 的 `capabilities.invariants`。
   */
  const invariantsAttached = (() => {
    try {
      const invariants = ctx.get('invariants')
      if (invariants === undefined || typeof invariants.register !== 'function') return false
      invariants.register('dsh-neural-workflow', (sink) => {
        // 适配器只做**词表与引用**这一层（能静态判的部分），
        // 真正的时间序约束仍由中间件在落账前判——不在这里造第二套判定。
        const fail = typeof sink === 'function' ? sink : sink?.fail
        if (typeof fail !== 'function') return
        return (candidate) => {
          const node = candidate?.node
          const kind = candidate?.kind
          if (node === undefined && kind === undefined) return
          const verdict = validateEvidence(node, kind)
          if (!verdict.ok) fail(`${verdict.code}: ${verdict.message}`)
        }
      })
      return true
    } catch (error) {
      report(`neural-workflow: 宿主不变量没挂上（${String(error?.message ?? error).slice(0, 120)}）`, 'warn')
      return false
    }
  })()


  // ── 服务读取：全部走「拿不到就降级」，绝不让面板把宿主搞坏 ─────────────────
  const serviceOf = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const sessionOf = (sessionId) => {
    const sessions = serviceOf('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }
  const stateOf = (sessionId) => {
    const session = sessionOf(sessionId)
    if (session === undefined) return undefined
    const projections = serviceOf('sessionProjections')
    if (projections === undefined || typeof projections.stateOf !== 'function') return undefined
    try {
      return projections.stateOf(session, DETAIL)
    } catch {
      return undefined
    }
  }

  /** 账本：优先投影，投影缺失时从日志冷读（同一份纯折法，不另建索引）。 */
  const ledgerOf = (sessionId) => {
    const fromProjection = stateOf(sessionId)
    if (fromProjection !== undefined) return fromProjection.ledger ?? []
    const session = sessionOf(sessionId)
    if (session === undefined || typeof session.snapshotEvents !== 'function') return []
    try {
      return foldEvents(session.snapshotEvents(0, eventsLimit)).ledger
    } catch {
      return []
    }
  }

  const lastVerdict = new Map()

  const judge = async (sessionId, evidence) => {
    const response = await worker.request('evaluate', { graph: GRAPH_DOC, evidence, now: new Date().toISOString() })
    if (response.ok !== true) {
      return { degraded: true, reason: response?.error?.message ?? '中间件不可用', code: response?.error?.code ?? 'E_WORKER' }
    }
    lastVerdict.set(sessionId, response.value)
    return response.value
  }

  // ── ① 投影单元 ────────────────────────────────────────────────────────────
  ctx.effect(
    () => {
      const projections = serviceOf('sessionProjections')
      if (projections === undefined || typeof projections.register !== 'function') {
        report('neural-workflow: sessionProjections 不可用，账本改从日志冷读', 'warn')
        return () => {}
      }
      const disposers = []
      for (const [key, view] of [
        [TIMELINE, (state) => ({ total: (state.ledger ?? []).length, seq: state.seq ?? 0, recent: state.recent ?? [] })],
        [DETAIL, (state) => ({ total: (state.ledger ?? []).length, ledger: state.ledger ?? [] })],
      ]) {
        disposers.push(
          projections.register({
            key,
            stateVersion: 1,
            stateSchema: passthrough(key),
            init: () => foldEvents([]),
            apply: (state, event) => applyEventSafe(state, event),
            wire: { viewSchema: passthrough(`${key}:view`), view },
          }),
        )
      }
      return () => {
        for (const dispose of disposers) if (typeof dispose === 'function') dispose()
      }
    },
    'neural-workflow: projection units',
  )

  // ── ② 运行时上下文：把前沿与违规交给模型 ─────────────────────────────────
  let currentSession
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'neural-workflow:constraints',
        order: contextOrder,
        text: () => {
          if (currentSession === undefined) return ''
          const verdict = lastVerdict.get(currentSession)
          if (verdict === undefined) return ''
          const text = renderBrief(verdict)
          if (text === '') return ''

          // 自动召回（学 Veyra 的 per-turn recall）：按**当前前沿节点**把本项目
          // 自己的经验带进上下文。只带 3 条、只带标题与一句做法——不是把账本倒进来。
          // 召回失败时安静跳过：提示词段落不许因为记忆读不出来而变空。
          let recalled = ''
          try {
            const store = resolveStore(ctx, currentSession, sessionOf)
            const frontierId = Array.isArray(verdict.frontier) ? verdict.frontier[0] : ''
            const node = nodeOf(frontierId)
            const query = node === undefined ? String(frontierId ?? '') : `${node.id} ${node.name?.zh ?? ''}`
            if (query.trim() !== '') {
              const lessons = store.search(query, 3).filter((item) => item.standing !== 'candidate')
              if (lessons.length > 0) {
                recalled = `\n本项目经验（按当前阶段召回）：\n${lessons.map((item) => `- ${item.id} ${item.title}`).join('\n')}`
              }
            }
          } catch {
            recalled = ''
          }
          return `[neural-workflow]\n${text}${recalled}`
        },
      }),
    'neural-workflow: constraint context',
  )

  // ── ③ 工具：模型用它在工作流上落证据 ──────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'neural_flow',
        description:
          'Record, inspect, or look up knowledge for the neural-network research workflow. "status" returns the current constraint verdict (frontier, blocked nodes, violations). "record" appends one evidence node; the middleware validates it first, and a rejected record explains which constraint blocked it, so fix that instead of retrying blindly. Evidence needs node + kind, and nodes that require traceability also need anchors[].path. Use kind "failure" for a failure that already happened: failures are always admissible (they are facts) but never satisfy a node. "knowledge" searches this project\'s own lesson library (611 entries: known errors, methods, idea/experiment recipes) and returns the matching entries; pass entry to read one in full before applying it.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'record', 'knowledge', 'experience', 'state', 'plan', 'run'], description: 'status = read the verdict; record = append evidence; knowledge = search the built-in lesson library; experience = this project\'s own experience ledger (record/search/feedback/promote/contradictions/recurrence/backflow); state = cross-session claim-evidence map and run registry (claims/addClaim/linkEvidence/runs); plan = pick the next stage with its lessons and gate commands; run = dispatch ONE stage subagent (the stage brief includes gates, lessons and the evidence-recording instruction).' },
            sub: { type: 'string', description: 'For experience: record | search | feedback | promote | contradictions | recurrence.' },
            title: { type: 'string', description: 'For experience record: one-line lesson title.' },
            body: { type: 'string', description: 'For experience record: what was learned, with enough context to reuse.' },
            id: { type: 'string', description: 'For experience feedback/promote: the record id.' },
            outcome: { type: 'string', enum: ['success', 'failure'], description: 'For experience feedback: whether applying the lesson worked.' },
            to: { type: 'string', enum: ['derived', 'canonical'], description: 'For experience promote: target standing.' },
            explicit: { type: 'boolean', description: 'For experience promote: required true to promote to canonical (a human decision).' },
            scope: { type: 'object', description: 'For experience record: applicability ({conditions, ranges, units, note}).' },
            threshold: { type: 'number', description: 'For experience recurrence: minimum cluster size (default 3).' },
            draftId: { type: 'string', description: 'For experience backflow-promote: the draft id (DRAFT-…).' },
            npId: { type: 'string', description: 'For experience backflow-promote: target knowledge-graph id (NP###); the graph file must not exist yet.' },
            node: { type: 'string', description: 'Target workflow node id, e.g. scope, develop, train, infer, validate, conclude, write, figure, polish, submit.' },
            kind: { type: 'string', description: 'Evidence kind, e.g. hypothesis, baseline, test, run, result, ablation, claim, draft, figure, submission, completion.' },
            note: { type: 'string', description: 'One-line statement of what this evidence establishes.' },
            query: { type: 'string', description: 'For action=knowledge: the symptom or question to look up, e.g. "AUC=1.0" or "怎么做消融".' },
            entry: { type: 'string', description: 'For action=knowledge: exact entry id (NP001…) to read in full.' },
            limit: { type: 'number', description: 'For action=knowledge: how many matches to return (default 6).' },
            anchors: {
              type: 'array',
              description: 'Traceability anchors: workspace-relative paths the evidence lives in.',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, note: { type: 'string' } },
                required: ['path'],
              },
            },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, execution) {
          const sessionId = String(execution?.agent?.id ?? '')
          currentSession = sessionId === '' ? currentSession : sessionId
          const action = String(args?.action ?? 'status')

          // 知识库检索不依赖会话：它是纯查表，先处理，免得被"没有会话"挡住。
          if (action === 'knowledge') {
            const entryId = String(args?.entry ?? '').trim()
            if (entryId !== '') {
              const found = kb.full(entryId)
              if (found === undefined) {
                return { ok: false, reason: 'unknown_entry', detail: `没有 ${entryId} 这条；先用 query 检索。` }
              }
              const head = kb.entry(entryId)
              return { ok: true, entry: { id: entryId, title: head?.t, category: head?.c, severity: head?.s, stage: head?.st, ...found } }
            }
            const query = String(args?.query ?? '').trim()
            if (query === '') return { ok: false, reason: 'missing_fields', detail: 'knowledge 需要 query 或 entry。' }
            const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, Math.trunc(args.limit))) : 6
            const matches = kb.search(query, limit)
            if (matches.length === 0) {
              return { ok: true, query, matches: [], total: kb.KB_TOTAL, detail: '没有命中；换一个症状词，或直接用英文关键词。' }
            }
            // 命中后带上摘要：多数情况读完摘要就够用，只有需要细节时才按 entry 取全文。
            return {
              ok: true,
              query,
              total: kb.KB_TOTAL,
              matches: matches.map((item) => ({ ...item, gist: kb.full(item.id)?.approach?.slice(0, 240) ?? '' })),
            }
          }

          if (sessionId === '') return { ok: false, reason: 'no_session', detail: '没有活动会话可供落账。' }

          // ── 经验账本：沉淀 / 检索 / 反馈 / 升格 / 矛盾 / 复发 ──────────────
          //
          // 学 Veyra 的生命周期：新经验是 candidate，成功应用两次才升 derived，
          // canonical 必须人工 explicit。矛盾双方保持可见，永不自动合并。
          if (action === 'experience') {
            const store = resolveStore(ctx, sessionId, sessionOf)
            const sub = String(args?.sub ?? 'search')
            try {
              if (sub === 'record') {
                const title = String(args?.title ?? '').trim()
                if (title === '') return { ok: false, reason: 'missing_fields', detail: 'record 需要 title。' }
                const record = store.record({
                  title,
                  body: String(args?.body ?? ''),
                  kind: String(args?.kind ?? 'lesson'),
                  scope: typeof args?.scope === 'object' && args.scope !== null ? args.scope : undefined,
                  anchors: Array.isArray(args?.anchors) ? args.anchors : [],
                  sourceEvent: String(args?.sourceEvent ?? ''),
                })
                return { ok: true, sub, record }
              }
              if (sub === 'feedback') {
                const id = String(args?.id ?? '').trim()
                if (id === '') return { ok: false, reason: 'missing_fields', detail: 'feedback 需要 id。' }
                const outcome = String(args?.outcome ?? 'success')
                return { ok: true, sub, record: store.feedback(id, outcome, String(args?.note ?? '')) }
              }
              if (sub === 'promote') {
                const id = String(args?.id ?? '').trim()
                if (id === '') return { ok: false, reason: 'missing_fields', detail: 'promote 需要 id。' }
                return { ok: true, sub, record: store.promote(id, String(args?.to ?? 'derived'), { explicit: args?.explicit === true }) }
              }
              if (sub === 'contradictions') return { ok: true, sub, contradictions: store.contradictions() }
              if (sub === 'recurrence') {
                const threshold = Number.isFinite(args?.threshold) ? Math.trunc(args.threshold) : 3
                return { ok: true, sub, clusters: store.recurrence(threshold) }
              }
              // 经验回流：运行时教训 → skill 知识图谱的 DRAFT。promote 必须人工 explicit。
              if (sub === 'backflow' || sub === 'backflow-promote') {
                const backflow = resolveBackflow(ctx, sessionId, sessionOf, config)
                if (backflow === undefined) {
                  return { ok: false, reason: 'skill_dir_missing', detail: '找不到 skill 知识图谱目录（config.skillDir / NEURAL_PAPER_SKILL / 工作区内 skills/neural-paper-workflow）。' }
                }
                if (sub === 'backflow') {
                  let record = null
                  const sourceId = String(args?.id ?? '').trim()
                  if (sourceId !== '') {
                    record = store.all().find((item) => item.id === sourceId)
                    if (record === undefined) return { ok: false, reason: 'unknown_entry', detail: `经验账本里没有 ${sourceId}。` }
                  } else {
                    const title = String(args?.title ?? '').trim()
                    if (title === '') return { ok: false, reason: 'missing_fields', detail: 'backflow 需要 id（已有经验）或 title/body/kind（新经验）。' }
                    record = { id: `exp-${Date.now().toString(36)}`, title, body: String(args?.body ?? ''), kind: String(args?.kind ?? 'lesson'), scope: args?.scope, anchors: Array.isArray(args?.anchors) ? args.anchors : [], createdAt: new Date().toISOString(), applications: [], standing: 'candidate' }
                  }
                  const written = backflow.writeDraft(record)
                  return { ok: true, sub, draft: written.draft, skipped: written.skipped === true, detail: written.skipped === true ? '同一经验的草稿已存在且一致，跳过。' : '草稿已写入 skill 的 drafts 目录，等待人工审阅。' }
                }
                const draftId = String(args?.draftId ?? '').trim()
                const npId = String(args?.npId ?? '').trim()
                if (draftId === '' || npId === '') return { ok: false, reason: 'missing_fields', detail: 'backflow-promote 需要 draftId 与 npId。' }
                const promoted = backflow.promoteDraft(draftId, npId, { explicit: args?.explicit === true })
                return { ok: true, sub, ...promoted, detail: `草稿已写入 ${npId}。正式化（字段校验/文档化）走 skill 侧人工流程。` }
              }
              const query = String(args?.query ?? '').trim()
              const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, Math.trunc(args.limit))) : 6
              return { ok: true, sub: 'search', query, matches: store.search(query, limit), total: store.all().length }
            } catch (error) {
              return { ok: false, reason: 'experience_error', detail: String(error?.message ?? error) }
            }
          }

          // ── 项目状态：claim-evidence map + run 登记（跨会话） ─────────────────
          if (action === 'state') {
            const state = resolveState(ctx, sessionId, sessionOf)
            const sub = String(args?.sub ?? 'claims')
            try {
              if (sub === 'addClaim') {
                const text = String(args?.title ?? '').trim()
                if (text === '') return { ok: false, reason: 'missing_fields', detail: 'addClaim 需要 title（主张文本）。' }
                return { ok: true, sub, claim: state.addClaim({ text, node: String(args?.node ?? '') }) }
              }
              if (sub === 'linkEvidence') {
                const claimId = String(args?.id ?? '').trim()
                if (claimId === '') return { ok: false, reason: 'missing_fields', detail: 'linkEvidence 需要 id（claim id）。' }
                return { ok: true, sub, claim: state.linkEvidence(claimId, { at: new Date().toISOString(), node: String(args?.node ?? ''), kind: String(args?.kind ?? 'note'), note: String(args?.note ?? ''), anchors: Array.isArray(args?.anchors) ? args.anchors : [] }) }
              }
              if (sub === 'runs') return { ok: true, sub, runs: state.runs().slice(-20).reverse() }
              return { ok: true, sub: 'claims', claims: state.claims() }
            } catch (error) {
              return { ok: false, reason: 'state_error', detail: String(error?.message ?? error) }
            }
          }

          // ── 派发：按判定选下一阶段，带经验与门禁 ────────────────────────────
          if (action === 'plan') {
            const verdict = await judge(sessionId, ledgerOf(sessionId))
            if (verdict?.degraded === true) {
              return { ok: false, reason: 'middleware_unavailable', detail: verdict.reason, degraded: true }
            }
            const store = resolveStore(ctx, sessionId, sessionOf)
            let lessons
            try {
              // 先按"当前可推进节点"召回，再退化到它的名称；召回不到就空数组（不硬凑）。
              const target = Array.isArray(verdict.frontier) ? verdict.frontier[0] : ''
              const node = nodeOf(target)
              const query = node === undefined ? target : `${node.id} ${node.name?.zh ?? ''} ${node.stage ?? ''}`
              lessons = store.search(query, 6)
            } catch {
              lessons = []
            }
            const budget = new Budget(resolveBudget(config.budget ?? {}), { now: () => Date.now() })
            const plan = planStep({ verdict, graph: GRAPH_DOC, lessons, budget })
            return { ok: true, action: 'plan', plan, verdict: { frontier: verdict.frontier, progress: verdict.progress, violations: verdict.violations } }
          }

          // ── 派发执行：起一个阶段子代理，一次一阶段 ────────────────────────────
          //
          // spec 形状学自 clearai-kernel 的真实调用（provider 'spawn'、delivery 'caller'、
          // request.prompt 走 content blocks、request.parent 传父 Agent）。
          // 刻意**不写循环**：每次调用只跑一个阶段；循环与停机判断留在调用方，
          // 这样预算闸在每一轮都被真正过一遍，而不是藏在某个 while 里。
          if (action === 'run') {
            const subagents = serviceOf('subagents')
            if (subagents === undefined || typeof subagents.startActivation !== 'function') {
              return { ok: false, reason: 'capability_off', detail: 'subagents 服务不可用，无法派发阶段子代理。' }
            }
            const verdict = await judge(sessionId, ledgerOf(sessionId))
            if (verdict?.degraded === true) {
              return { ok: false, reason: 'middleware_unavailable', detail: verdict.reason, degraded: true }
            }
            const store = resolveStore(ctx, sessionId, sessionOf)
            let lessons = []
            try {
              const target = Array.isArray(verdict.frontier) ? verdict.frontier[0] : ''
              const node = nodeOf(target)
              lessons = node === undefined ? [] : store.search(`${node.id} ${node.name?.zh ?? ''}`, 6)
            } catch {
              lessons = []
            }
            const budget = new Budget(resolveBudget(config.budget ?? {}), { now: () => Date.now() })
            const plan = planStep({ verdict, graph: GRAPH_DOC, lessons, budget })
            if (plan?.stop === true) {
              return { ok: true, action: 'run', stopped: true, reason: plan.reason, progress: verdict.progress }
            }

            // 阶段简报：目标、验收、门禁命令、已召回经验。子代理拿到就能干活，
            // 干完必须用 neural_flow 落证据——它落不进来，判定会说明卡在哪。
            const node = plan.node
            const briefLines = [
              `你是研究工作流的阶段执行者。当前阶段：${node.id}（${node.name?.zh ?? node.id}）。`,
              `做什么：${node.hint?.zh ?? ''}`,
              `退出门（全部满足才算完成）：${node.gate?.zh ?? ''}`,
              plan.gates.length > 0 ? `门禁命令（在项目根目录逐条运行，记录输出）：\n${plan.gates.map((gate) => `- ${gate}`).join('\n')}` : '门禁命令：本阶段无脚本门。',
              plan.lessons.length > 0 ? `本项目经验（必读）：\n${plan.lessons.map((item) => `- ${item.id} ${item.title}`).join('\n')}` : '',
              `完成后：用 neural_flow 工具 record 落证据（node="${node.id}"，kind 按 evidenceKinds ${JSON.stringify(node.evidenceKinds ?? [])}，必须带 anchors[].path 指向真实产物）。`,
              `若本阶段做不下去：用 kind="failure" 记录失败事实（失败允许入账），并说明卡点。`,
            ].filter(Boolean)
            const brief = briefLines.join('\n\n')

            // 跨会话运行登记：这个阶段由哪个子代理在跑，换会话也能看到。
            const state = resolveState(ctx, sessionId, sessionOf)
            let run = null
            try {
              run = state.recordRun({ node: plan.nodeId, sessionId, status: 'running' })
            } catch {
              run = null
            }

            try {
              const activation = await subagents.startActivation({
                provider: String(config.subagentProvider ?? 'spawn'),
                label: `neural-workflow:${plan.nodeId}`,
                delivery: 'caller',
                signal: execution?.signal ?? new AbortController().signal,
                request: {
                  prompt: [{ type: 'text', text: brief }],
                  parent: execution?.agent,
                },
              })
              try {
                state.finishRun(String(run?.id ?? ''), { status: 'ok', progress: verdict.progress })
              } catch {
                /* 登记失败不影响派发结果 */
              }
              return {
                ok: true,
                action: 'run',
                node: plan.nodeId,
                why: plan.why,
                childId: activation?.childId ? String(activation.childId) : null,
                result: lossless(activation?.result),
                gates: plan.gates,
                lessons: plan.lessons.map((item) => item.id),
              }
            } catch (error) {
              try {
                state.finishRun(String(run?.id ?? ''), { status: 'failed' })
              } catch {
                /* 登记失败不影响错误回报 */
              }
              return { ok: false, reason: 'spawn_error', detail: String(error?.message ?? error).slice(0, 300), node: plan.nodeId }
            }
          }

          if (action === 'record') {
            const node = String(args?.node ?? '').trim()
            const kind = String(args?.kind ?? '').trim()
            if (node === '' || kind === '') return { ok: false, reason: 'missing_fields', detail: 'record 需要 node 与 kind。' }
            // 词表前置：把"字母打错"变成一句能改的话。它只会多拒、不会多收——
            // 放行之后仍然要过中间件；判据只有 Rust 那一份。
            const lexical = validateEvidence(node, kind)
            if (!lexical.ok) {
              return { ok: false, reason: lexical.code, detail: lexical.message, candidates: lexical.candidates }
            }
            // 会话必须活着：证据要靠它的事件日志落盘（没有会话就没有账本）。
            if (sessionOf(sessionId) === undefined) return { ok: false, reason: 'no_live_session', detail: '会话已不在内存中。' }

            const payload = {
              id: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              node,
              kind,
              at: new Date().toISOString(),
              note: typeof args?.note === 'string' ? args.note : '',
              anchors: Array.isArray(args?.anchors) ? args.anchors : [],
            }

            // 先判后落：拒绝时把诊断回给模型，让它修正——不写进日志，账本才不是宣称。
            const verdict = await judge(sessionId, [...ledgerOf(sessionId), payload])
            if (verdict?.degraded === true) {
              return { ok: false, reason: 'middleware_unavailable', detail: verdict.reason, degraded: true }
            }
            const violations = Array.isArray(verdict?.violations) ? verdict.violations : []
            if (violations.length > 0) {
              return {
                ok: false,
                reason: 'constraint_violation',
                violations,
                detail: `该证据违反约束：${violations.map((item) => `${item.constraint} ${item.message}`).join('；')}`,
              }
            }

            // 落账成功：证据随**工具结果**写进日志（不追加聊天消息——证据不是对话内容）。
            // 折账侧只认带 recorded:true 的结果，所以这一次拒绝的下一次重试不会重复计数。
            return {
              ok: true,
              recorded: true,
              evidence: payload,
              node,
              kind,
              id: payload.id,
              progress: verdict?.progress,
              frontier: verdict?.frontier,
            }
          }

          const verdict = await judge(sessionId, ledgerOf(sessionId))
          if (verdict?.degraded === true) {
            return { ok: false, reason: 'middleware_unavailable', detail: verdict.reason, degraded: true }
          }
          return { ok: true, verdict }
        },
      }),
    'neural-workflow: tool',
  )

  // ── 服务面：panel / enforce 行经 inject('neuralWorkflow') 拿到同一份运行时 ──
  // 同一个 worker、同一份投影、同一个判定——第二份运行时就是我们明确拒绝的事。
  const api = {
    judge,
    ledgerOf,
    sessionOf,
    setCurrentSession: (id) => {
      currentSession = id
    },
    resolveStore,
    resolveState,
    resolveBackflow,
    worker,
    binary,
    invariantsAttached,
    serviceOf,
    config,
  }
  ctx.effect(() => ctx.provide('neuralWorkflow', api), 'neural-workflow: service')
}

/**
 * 面板行：只挂 HTTP 面，运行时经服务注入。
 * 知识路由按 kb 行是否装载动态降级——关掉 kb 行时明确报能力缺失，不静默给空结果。
 */
function applyPanel(ctx, config, api) {
  const reply = (payload, status = 200) => Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })

  ctx.inject(['connection'], (connectionCtx) => {
    const route = (path, methods, handler) =>
      connectionCtx.effect(
        () =>
          connectionCtx.connection.fetch.register({
            path,
            methods,
            requestBody: 'buffered',
            fetch: (request) => Promise.resolve(handler(request)),
          }),
        `neural-workflow: ${path}`,
      )

    route('/api/neural-workflow/graph', ['GET'], async () =>
      reply({
        ok: true,
        graph: GRAPH_DOC,
        constraints: CONSTRAINT_DOC,
        binary: api.binary ?? null,
        degraded: api.api.worker.degraded,
      }),
    )

    // 知识库：与工具里的 action=knowledge 走同一个检索函数，面板因此和模型看到同一批条目。
    const kbApi = api.serviceOf('neuralWorkflowKb')
    route('/api/neural-workflow/knowledge', ['POST'], async (request) => {
      if (kbApi === undefined) {
        return reply({ ok: false, error: { code: 'E_CAPABILITY', message: 'kb 行未装载（neural-workflow-kb 已禁用）' } }, 503)
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return reply({ ok: false, error: { code: 'E_BODY', message: 'body 不是合法 JSON' } }, 400)
      }
      const entryId = typeof body?.entry === 'string' ? body.entry.trim() : ''
      if (entryId !== '') {
        const found = kb.full(entryId)
        if (found === undefined) return reply({ ok: false, error: { code: 'E_NOT_FOUND', message: `没有 ${entryId}` } }, 404)
        return reply({ ok: true, entry: { id: entryId, ...kb.entry(entryId), ...found } })
      }
      const query = typeof body?.query === 'string' ? body.query.trim() : ''
      if (query === '') return reply({ ok: true, matches: [], stats: kb.stats() })
      const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(30, Math.trunc(body.limit))) : 12
      return reply({ ok: true, query, matches: kb.search(query, limit), stats: kb.stats() })
    })

    // 派发计划：与工具 action=plan 同一条路径（judge → planStep）。
    route('/api/neural-workflow/plan', ['POST'], async (request) => {
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return reply({ ok: false, error: { code: 'E_BODY', message: 'body 不是合法 JSON' } }, 400)
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return reply({ ok: false, error: { code: 'E_BODY', message: '缺少 sessionId' } }, 400)
      api.setCurrentSession(sessionId)
      const verdict = await api.judge(sessionId, api.ledgerOf(sessionId))
      if (verdict?.degraded === true) return reply({ ok: false, degraded: true, reason: verdict.reason })
      const budget = new Budget(resolveBudget(api.config.budget ?? {}), { now: () => Date.now() })
      const plan = planStep({ verdict, graph: GRAPH_DOC, lessons: [], budget })
      return reply({ ok: true, plan, verdict: { frontier: verdict.frontier, progress: verdict.progress, violations: verdict.violations } })
    })

    // 经验账本（面板只读：search / contradictions / recurrence / 列表）。
    // 刻意**不开写入口**（学 clearAI：面板不许绕过判定）——沉淀与反馈走工具。
    route('/api/neural-workflow/experience', ['POST'], async (request) => {
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return reply({ ok: false, error: { code: 'E_BODY', message: 'body 不是合法 JSON' } }, 400)
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return reply({ ok: false, error: { code: 'E_BODY', message: '缺少 sessionId' } }, 400)
      try {
        const store = api.resolveStore(ctx, sessionId, api.sessionOf)
        const sub = typeof body?.sub === 'string' ? body.sub : 'search'
        if (sub === 'contradictions') return reply({ ok: true, contradictions: store.contradictions() })
        if (sub === 'recurrence') return reply({ ok: true, clusters: store.recurrence(Number.isFinite(body?.threshold) ? Math.trunc(body.threshold) : 3) })
        if (sub === 'runs' || sub === 'claims') {
          const state = api.resolveState(ctx, sessionId, api.sessionOf)
          return reply({ ok: true, [sub]: sub === 'runs' ? state.runs().slice(-20).reverse() : state.claims() })
        }
        if (sub === 'list') {
          const records = store.all()
          return reply({ ok: true, total: records.length, records: records.slice(-30).reverse() })
        }
        const query = typeof body?.query === 'string' ? body.query.trim() : ''
        const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(20, Math.trunc(body.limit))) : 6
        return reply({ ok: true, matches: query === '' ? [] : store.search(query, limit), total: store.all().length })
      } catch (error) {
        return reply({ ok: false, error: { code: 'E_EXPERIENCE', message: String(error?.message ?? error) } })
      }
    })

    // 面板**不提供**任何写操作路由（学 clearAI：面板没有写入口）。
    // 派发/记录/反馈/升格全部走 neural_flow 工具——它们要过判定、预算与会话身份，
    // 而这三样都在 Agent 侧。面板只读同一份判定结果，绝不旁路。
    route('/api/neural-workflow/state', ['POST'], async (request) => {
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return reply({ ok: false, error: { code: 'E_BODY', message: 'body 不是合法 JSON' } }, 400)
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return reply({ ok: false, error: { code: 'E_BODY', message: '缺少 sessionId' } }, 400)
      api.setCurrentSession(sessionId)

      const ledger = api.ledgerOf(sessionId)
      /**
       * 运行登记（哪个阶段派发过子代理、什么状态）随判定一起下发。
       *
       * 这是本面板相对任务管理插件的**增量**：任务管理只知道"谁在跑"，
       * 这里能把每一次派发钉在**阶段**上，于是"训练阶段跑过几次、上次成功没有"
       * 与阶段图是同一屏的事。读失败就返回空数组并带 `runsError`，
       * 不因为一个附属数据源把整块面板打成 degraded。
       */
      let runs = []
      let runsError
      try {
        runs = api.resolveState(ctx, sessionId, api.sessionOf).runs().slice(-20).reverse()
      } catch (error) {
        runsError = String(error?.message ?? error)
      }
      const verdict = await api.judge(sessionId, ledger)
      if (verdict?.degraded === true) {
        return reply({ ok: true, found: true, ledger, runs, runsError, degraded: true, reason: verdict.reason })
      }
      return reply({ ok: true, found: true, ledger, runs, runsError, verdict, brief: brief(verdict) })
    })

    route('/api/neural-workflow/selftest', ['GET'], async () => {
      const response = await worker.request('selftest', {})
      return reply({
        ok: response.ok === true,
        binary: api.binary ?? null,
        value: response.value ?? null,
        error: response.error ?? null,
        capabilities: {
          // 每条都能当场证伪：缺失就是 false，不写"应该支持"。
          middleware: api.binary !== undefined && api.worker.degraded !== true,
          invariants: api.invariantsAttached,
          knowledge: kb.KB_TOTAL,
          failureAdmission: true,
          vocabulary: true,
        },
      })
    })
  })
}


/** kb 行：把经验库检索作为**能力服务**提供；panel 行的 /knowledge 路由按它降级。 */
function applyKbRole(ctx) {
  ctx.effect(
    () =>
      ctx.provide('neuralWorkflowKb', {
        search: kb.search,
        full: kb.full,
        entry: kb.entry,
        stats: kb.stats,
        total: kb.KB_TOTAL,
      }),
    'neural-workflow: kb service',
  )
}

/**
 * enforce 行：**真实工具调用**上的第二道闸（学 dsh-ops 的 guard 分层）。
 * 判定仍只属于中间件；这里只回放"判定已经说出来的违规"，绝不发明新判据。
 * 刻意默认关（组合里 disabled: true）——拦 write/edit 是侵入性的，要显式开。
 */
function applyEnforceRole(ctx, config) {
  if (config.mode !== 'deny') return
  ctx.inject(['neuralWorkflow'], (svcCtx) => {
    const api = svcCtx.get('neuralWorkflow')
    svcCtx.effect(
      () =>
        svcCtx.tools.guard((execution) => {
          const name = String(execution?.name ?? '')
          if (name !== 'write' && name !== 'edit') return undefined
          const sessionId = String(execution?.agent?.id ?? '')
          if (sessionId === '') return undefined
          const verdict = api.lastVerdict.get(sessionId)
          if (verdict === undefined) return undefined
          const outOfOrder = (verdict.violations ?? []).filter((item) => item?.constraint === 'C3')
          if (outOfOrder.length === 0) return undefined
          return `neural-workflow (enforce): 当前存在越序违规（C3）：${outOfOrder[0].message} 先补齐上游节点的证据，再改动这一层。`
        }),
      'neural-workflow: enforce guard',
    )
  })
}

/**
 * 角色分派器：四个组合行共享这一个模块。
 *   core（必需）    投影 + 工具 + 提示词 + 不变量 + 运行时服务
 *   panel           面板 HTTP 面
 *   kb              经验库能力服务（panel 的 /knowledge 按它降级）
 *   enforce（默认关）真实工具调用上的 C3 回放守卫
 */
export function apply(ctx, config = {}) {
  const role = String(config.role ?? 'core')
  if (role === 'panel') {
    ctx.inject(['neuralWorkflow'], (svcCtx) => {
      applyPanel(svcCtx, config, svcCtx.get('neuralWorkflow'))
    })
    return
  }
  if (role === 'kb') return applyKbRole(ctx)
  if (role === 'enforce') return applyEnforceRole(ctx, config)
  return applyCore(ctx, config)
}


/** fold 的薄封装：同一份纯折法；坏事件不该让投影驱动崩掉。 */
function applyEventSafe(state, event) {
  try {
    return applyEvent(state, event)
  } catch {
    return state
  }
}
