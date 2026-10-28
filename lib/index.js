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

export const name = 'neural-workflow'

/** 宿主服务：投影注册表 + 会话存储 + 工具注册表 + 系统提示词注册表。 */
export const inject = ['sessionProjections', 'sessions', 'tools', 'systemPrompt']

const BINARY = process.platform === 'win32' ? 'nw-constrain.exe' : 'nw-constrain'

/** 本包根目录（`lib/index.js` 与 `src/index.js` 两种布局都正确）。 */
function packageRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/** 找到二进制；找不到返回 undefined（**不用 JS 兜底**——降级要说真话）。 */
function locateBinary(configured) {
  const root = packageRoot()
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
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

export function apply(ctx, config = {}) {
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
          return text === '' ? '' : `[neural-workflow]\n${text}`
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
          'Record, inspect, or look up knowledge for the neural-network research workflow. "status" returns the current constraint verdict (frontier, blocked nodes, violations). "record" appends one evidence node; the middleware validates it first, and a rejected record explains which constraint blocked it, so fix that instead of retrying blindly. Evidence needs node + kind, and nodes that require traceability also need anchors[].path. "knowledge" searches this project\'s own lesson library (611 entries: known errors, methods, idea/experiment recipes) and returns the matching entries; pass entry to read one in full before applying it.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'record', 'knowledge'], description: 'status = read the verdict; record = append evidence; knowledge = search the lesson library.' },
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

          if (action === 'record') {
            const node = String(args?.node ?? '').trim()
            const kind = String(args?.kind ?? '').trim()
            if (node === '' || kind === '') return { ok: false, reason: 'missing_fields', detail: 'record 需要 node 与 kind。' }
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

  // ── ④ 面板 HTTP 面（connection exact fetch route 表） ──────────────────────
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
        binary: binary ?? null,
        degraded: worker.degraded,
      }),
    )

    // 知识库：与工具里的 action=knowledge 走同一个检索函数，面板因此和模型看到同一批条目。
    route('/api/neural-workflow/knowledge', ['POST'], async (request) => {
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

    route('/api/neural-workflow/state', ['POST'], async (request) => {
      let body
      try {
        body = await readJsonBody(request)
      } catch {
        return reply({ ok: false, error: { code: 'E_BODY', message: 'body 不是合法 JSON' } }, 400)
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return reply({ ok: false, error: { code: 'E_BODY', message: '缺少 sessionId' } }, 400)
      currentSession = sessionId

      const ledger = ledgerOf(sessionId)
      const verdict = await judge(sessionId, ledger)
      if (verdict?.degraded === true) {
        return reply({ ok: true, found: true, ledger, degraded: true, reason: verdict.reason })
      }
      return reply({ ok: true, found: true, ledger, verdict, brief: brief(verdict) })
    })

    route('/api/neural-workflow/selftest', ['GET'], async () => {
      const response = await worker.request('selftest', {})
      return reply({
        ok: response.ok === true,
        binary: binary ?? null,
        value: response.value ?? null,
        error: response.error ?? null,
      })
    })
  })
}

/** fold 的薄封装：同一份纯折法；坏事件不该让投影驱动崩掉。 */
function applyEventSafe(state, event) {
  try {
    return applyEvent(state, event)
  } catch {
    return state
  }
}
