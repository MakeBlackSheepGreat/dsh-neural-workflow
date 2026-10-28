/**
 * dsh-neural-workflow — 投影折账（host 平面）。
 *
 * 学 clearAI `fold.js` 的正形：**状态只有一个权威**（本文件的 `applyEvent`），
 * 面板、检查器、提示词段落都读同一份折出来的状态，谁也不另建一套索引。
 *
 * 证据从**工具结果**折出来（学 clearAI 把变更记录挂在工具结果上，而不是另写一条消息）：
 * `neural_flow` 落账成功后，结果 JSON 里带 `recorded:true` 与 `evidence`，
 * 框架把它作为 `tool/result` 事件写进会话日志——重启、续聊、压缩之后账本仍能重建，
 * 而且不往聊天里塞假的用户消息。
 */

/** 投影行：近期窗口，给面板与提示词用。 */
const TIMELINE = 'neuralWorkflow'

/** 投影行：全量账本，给面板按需拉取。 */
const DETAIL = 'neuralWorkflowDetail'

/** 近期窗口上限：提示词只需要"刚刚发生了什么"。 */
const MAX_RECENT = 24

/** 全量账本上限：够覆盖一篇论文的证据量，又不让投影行无界增长。 */
const MAX_LEDGER = 400

/** 单条证据的文本上限（note / anchors[].path）。 */
const MAX_TEXT = 280

function pick(value, limit = MAX_TEXT) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
}

/** 取一条 tool/result 消息里的第一段文本。 */
function firstText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return ''
}

/**
 * 从一条会话事件里取本插件的证据负载。
 *
 * 只认 `tool/result` 且内容 JSON 里带 `recorded:true` 的那条——被约束拒掉的记录
 * 没有这个标记，所以**拒绝不会入账**（账本不许被"差点发生"的事实污染）。
 */
export function evidenceOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type !== 'tool/result') return null
  const text = firstText(event.data?.message)
  if (text.trim() === '') return null

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object') return null
  if (payload.recorded !== true) return null
  const evidence = payload.evidence
  if (evidence === null || typeof evidence !== 'object') return null
  if (typeof evidence.id !== 'string' || evidence.id === '') return null
  if (typeof evidence.node !== 'string' || typeof evidence.kind !== 'string') return null

  const anchors = Array.isArray(evidence.anchors)
    ? evidence.anchors
        .filter((anchor) => anchor !== null && typeof anchor === 'object' && typeof anchor.path === 'string' && anchor.path.trim() !== '')
        .map((anchor) => ({ path: pick(anchor.path, 240), note: pick(anchor.note) }))
    : []

  return {
    id: evidence.id,
    node: evidence.node,
    kind: evidence.kind,
    at: typeof evidence.at === 'string' && evidence.at !== '' ? evidence.at : new Date(event.time ?? Date.now()).toISOString(),
    note: pick(evidence.note),
    anchors,
    seq: typeof event.seq === 'number' ? event.seq : undefined,
  }
}

/** 初始状态。 */
export function emptyState() {
  return { ledger: [], seen: {}, recent: [], seq: 0 }
}

/**
 * 折一条事件。**纯函数**：同一条日志折两遍，结果必须逐字节一致。
 * 重复 id 丢弃后者（记账纪律：一条事实只入账一次）。
 */
export function applyEvent(state, event) {
  const base = state ?? emptyState()
  const evidence = evidenceOf(event)
  if (evidence === null) return base
  if (Object.hasOwn(base.seen, evidence.id)) return base

  const ledger = [...base.ledger, evidence]
  const overflow = Math.max(0, ledger.length - MAX_LEDGER)
  const seen = { ...base.seen, [evidence.id]: true }
  if (overflow > 0) for (const dropped of ledger.slice(0, overflow)) delete seen[dropped.id]

  return {
    ledger: overflow > 0 ? ledger.slice(overflow) : ledger,
    seen,
    recent: [...base.recent, evidence].slice(-MAX_RECENT),
    seq: evidence.seq ?? base.seq,
  }
}

/** 从一份完整事件列表冷启动。 */
export function foldEvents(events) {
  let state = emptyState()
  for (const event of Array.isArray(events) ? events : []) state = applyEvent(state, event)
  return state
}

/** TIMELINE 的线上形状：刻意小。 */
export function timelineOf(state) {
  const current = state ?? emptyState()
  return { total: current.ledger.length, seq: current.seq, recent: current.recent }
}

/** DETAIL 的线上形状：全量，按需 HTTP 拉。 */
export function detailOf(state) {
  const current = state ?? emptyState()
  return { total: current.ledger.length, ledger: current.ledger }
}

export { TIMELINE, DETAIL, MAX_LEDGER, MAX_RECENT }
