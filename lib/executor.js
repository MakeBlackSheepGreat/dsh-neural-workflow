/**
 * dsh-neural-workflow — 执行器内核（Auto research P0）。
 *
 * 三层分工，谁也不越界：
 * - **判据只有一份**：`native/src/main.rs` 的 `evaluate`。本文件只读它的输出（verdict），
 *   绝不用 JS 重算约束——两套判据必然漂移（clearAI 的教训，见 `lib/constraints.js` 抬头）。
 * - **派发**（`planStep`）：从 verdict 的 frontier / violations 里挑**一个**节点，
 *   带上相关经验与门禁命令。一次只派一个阶段，不写死循环。
 * - **停机**（`Budget`）：`maxStages` / `maxWallMs` / `maxConsecutiveNoProgress`
 *   三条任一触发即停，并说明是哪一条。
 *
 * 子代理**不由本文件起**：`StageRunner` 的 `startStage` 由调用方注入（宿主侧接到
 * `ctx.subagents.startActivation`）。于是内核是纯逻辑，测试里换个假实现就能跑，
 * 也保证「一次一阶段」是调用方的显式节奏，而不是藏在库里的循环。
 *
 * 纯 ESM，零第三方依赖。
 */

/** 预算默认值：阶段数 6、墙钟 45 分钟、连续 2 次无进展即停。 */
const BUDGET_DEFAULTS = Object.freeze({
  maxStages: 6,
  maxWallMs: 45 * 60 * 1000,
  maxConsecutiveNoProgress: 2,
})

/** 合法区间。越界夹取，非数值回落到默认值。 */
const BUDGET_RANGES = Object.freeze({
  maxStages: Object.freeze({ min: 1, max: 50 }),
  maxWallMs: Object.freeze({ min: 1000, max: 24 * 60 * 60 * 1000 }),
  maxConsecutiveNoProgress: Object.freeze({ min: 1, max: 20 }),
})

/** 单轮最多带几条经验：提示词要短，多出来的由经验库自己排序负责。 */
const MAX_LESSONS = 6

/**
 * 把一个预算字段夹到合法区间。
 *
 * 语义刻意分成两档：**数字但越界** → 夹取（调用方意图明确，只是超限）；
 * **非数字**（字符串、NaN、缺省） → 回落默认值（意图不明时不猜）。
 * ±Infinity 视为越界而不是非法——它是数字，含义就是"无限"。
 */
function clampNumber(value, range, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (value === Number.POSITIVE_INFINITY) return range.max
  if (value === Number.NEGATIVE_INFINITY) return range.min
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/** 进度统一成 `{satisfied, total}`；坏值按 0 处理，绝不产出 NaN。 */
function normalizeProgress(progress) {
  const value = progress !== null && typeof progress === 'object' ? progress : {}
  return {
    satisfied: Number.isFinite(value.satisfied) ? value.satisfied : 0,
    total: Number.isFinite(value.total) ? value.total : 0,
  }
}

/**
 * 解析预算配置。**总是**返回三个字段，调用方不必再补默认值。
 *
 * @param {object|null|undefined} config 形如 `{maxStages, maxWallMs, maxConsecutiveNoProgress}`
 * @returns {{maxStages:number, maxWallMs:number, maxConsecutiveNoProgress:number}}
 */
export function resolveBudget(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const limits = {}
  for (const key of Object.keys(BUDGET_DEFAULTS)) limits[key] = clampNumber(source[key], BUDGET_RANGES[key], BUDGET_DEFAULTS[key])
  return limits
}

/**
 * 三道预算闸。纯计数，不落盘、不读时钟以外的外部状态。
 *
 * 时钟经 `{now}` 注入（毫秒时间戳），测试因此不依赖真实时间；
 * 也正因为墙钟是注入的，`maxWallMs` 在测试里可被精确触发。
 */
export class Budget {
  /**
   * @param {{maxStages?:number, maxWallMs?:number, maxConsecutiveNoProgress?:number}} limits
   * @param {{now?:() => number}} [options]
   */
  constructor(limits, { now } = {}) {
    this.limits = resolveBudget(limits)
    this.now = typeof now === 'function' ? now : Date.now
    /** 已经跑掉的阶段数。 */
    this.stages = 0
    /** 连续无进展次数（与上一次 `noteProgress` 的读数相同即 +1）。 */
    this.consecutiveNoProgress = 0
    /** 上一次的进度读数；`null` 表示还没读过。 */
    this.lastProgress = null
    this.startedAt = this.readClock()
  }

  /** 读时钟；时钟抛错或返回非数值时退回真实时间（观测不该弄停执行）。 */
  readClock() {
    try {
      const value = this.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** 已经过去的墙钟毫秒数（不倒流）。 */
  elapsedMs() {
    return Math.max(0, this.readClock() - this.startedAt)
  }

  /** 记一次阶段消耗。 */
  spendStage() {
    this.stages += 1
    return this.stages
  }

  /**
   * 记一次进度读数。与上次**完全相同**（satisfied 与 total 都没变）→ 无进展计数 +1；
   * 只要有一项变了 → 归零（有进展就把连续计数清掉，不累计历史）。
   *
   * @param {{satisfied:number, total:number}} progress
   * @returns {number} 当前的连续无进展次数
   */
  noteProgress(progress) {
    const current = normalizeProgress(progress)
    const same = this.lastProgress !== null
      && current.satisfied === this.lastProgress.satisfied
      && current.total === this.lastProgress.total
    this.consecutiveNoProgress = same ? this.consecutiveNoProgress + 1 : 0
    this.lastProgress = current
    return this.consecutiveNoProgress
  }

  /**
   * 判定是否该停。三闸顺序固定：阶段数 → 墙钟 → 无进展
   * （同时越限时报最先撞上的那条，`maxStages` 最确定，优先）。
   *
   * @returns {{stop:boolean, reason?: 'maxStages'|'maxWallMs'|'noProgress'}}
   */
  check() {
    if (this.stages >= this.limits.maxStages) return { stop: true, reason: 'maxStages' }
    if (this.elapsedMs() >= this.limits.maxWallMs) return { stop: true, reason: 'maxWallMs' }
    if (this.consecutiveNoProgress >= this.limits.maxConsecutiveNoProgress) return { stop: true, reason: 'noProgress' }
    return { stop: false }
  }
}

/** 一条违规是不是 C3 越序（`constraint` 或 `code` 任一命中都算）。 */
function isOutOfOrder(violation) {
  if (violation === null || typeof violation !== 'object') return false
  if (typeof violation.constraint === 'string' && violation.constraint.trim().toUpperCase() === 'C3') return true
  return typeof violation.code === 'string' && violation.code.trim().toUpperCase() === 'OUT_OF_ORDER'
}

/** 把 verdict 读成派发需要的三个视图，缺字段一律当空，不猜。 */
function readVerdict(verdict) {
  const value = verdict !== null && typeof verdict === 'object' ? verdict : {}
  const frontier = Array.isArray(value.frontier) ? value.frontier.filter((id) => typeof id === 'string' && id.trim() !== '') : []
  const violations = Array.isArray(value.violations) ? value.violations.filter((item) => item !== null && typeof item === 'object') : []
  const nodeStates = value.nodes !== null && typeof value.nodes === 'object' ? value.nodes : {}
  let progress = null
  if (value.progress !== null && typeof value.progress === 'object'
    && Number.isFinite(value.progress.satisfied) && Number.isFinite(value.progress.total)) {
    progress = { satisfied: value.progress.satisfied, total: value.progress.total }
  }
  return { frontier, violations, nodeStates, progress }
}

/** verdict 没带 progress 时，从节点状态数出来（只数 satisfied）。 */
function deriveProgress(view, nodes) {
  if (nodes.length === 0) return null
  let satisfied = 0
  for (const node of nodes) {
    const state = view.nodeStates[node.id]
    if (state !== null && typeof state === 'object' && state.state === 'satisfied') satisfied += 1
  }
  return { satisfied, total: nodes.length }
}

/** 全绿判定。total 为 0 时**不算**全绿（空图不是"做完了"）。 */
function allSatisfied(view, nodes) {
  const progress = view.progress ?? deriveProgress(view, nodes)
  if (progress === null) return false
  if (!Number.isFinite(progress.total) || progress.total <= 0) return false
  return progress.satisfied >= progress.total
}

/** 停机计划：形状与正常计划一致，只是 `node` 为空、带 `stop/reason`。 */
function stopPlan(reason, why) {
  return { node: null, nodeId: null, why, lessons: [], gates: [], stop: true, reason }
}

/** 预算若已越限，返回触发原因；否则 null。 */
function budgetStopReason(budget) {
  if (budget === null || typeof budget !== 'object' || typeof budget.check !== 'function') return null
  const verdict = budget.check()
  if (verdict === null || typeof verdict !== 'object' || verdict.stop !== true) return null
  return typeof verdict.reason === 'string' ? verdict.reason : 'budget'
}

/**
 * C3 越序的回补目标：取**被越序节点的上游**。
 * 上游里优先挑还没满足的那个（真正缺的是它）；都满足了就取第一个上游，让调用方重跑。
 *
 * @returns {{node: object, upstreamOf: string, why: string}|null}
 */
function pickBackfill(view, edges, byId) {
  for (const violation of view.violations) {
    if (!isOutOfOrder(violation)) continue
    const target = typeof violation.node === 'string' ? violation.node : ''
    if (target === '' || !byId.has(target)) continue
    const upstreams = []
    for (const edge of edges) {
      if (edge === null || typeof edge !== 'object') continue
      if (edge.to !== target) continue
      if (typeof edge.from !== 'string' || !byId.has(edge.from)) continue
      if (!upstreams.includes(edge.from)) upstreams.push(edge.from)
    }
    if (upstreams.length === 0) continue
    const unmet = upstreams.find((id) => {
      const state = view.nodeStates[id]
      return state === null || typeof state !== 'object' || state.state !== 'satisfied'
    })
    const pick = unmet ?? upstreams[0]
    return {
      node: byId.get(pick),
      upstreamOf: target,
      why: `C3 越序：${target} 的上游 ${pick} ${unmet === undefined ? '需重跑一遍' : '尚未满足'}，本轮先回补上游`,
    }
  }
  return null
}

/** 节点在派发时用到的文本特征：id / 层 / 阶段 / 分类 / 中英文名。 */
function lessonTokens(node) {
  const tokens = []
  for (const value of [node.id, node.layer, node.stage, node.category, node.name?.zh, node.name?.en]) {
    if (typeof value !== 'string') continue
    const token = value.trim().toLowerCase()
    if (token !== '' && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/** 经验条目自己声明的目标（有则按它判定，不再看正文）。 */
function lessonExplicitTargets(lesson) {
  const tokens = []
  for (const value of [lesson.node, lesson.stage, lesson.category, lesson.layer]) {
    if (typeof value !== 'string') continue
    const token = value.trim().toLowerCase()
    if (token !== '' && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/** 经验条目里可被检索的文字。 */
function lessonText(lesson) {
  const parts = []
  const push = (value) => {
    if (typeof value === 'string') {
      if (value.trim() !== '') parts.push(value)
      return
    }
    if (Array.isArray(value)) for (const item of value) push(item)
  }
  push(lesson.title)
  push(lesson.body)
  push(lesson.note)
  push(lesson.tags)
  push(lesson.scope?.note)
  push(lesson.scope?.conditions)
  return parts.join(' ').toLowerCase()
}

/**
 * 按节点挑经验。
 *
 * 判定顺序：条目已声明目标（node/stage/category/layer）→ **只**按目标比对，
 * 不命中即排除（显式声明不该被正文偶合翻盘）；没声明目标 → 按正文是否提到本节点的
 * id/层/阶段/分类/中英文名来判断。
 *
 * 输出只保留 `{id, title}`：派发侧不需要整条记录，正文由经验库自己按需展开。
 */
function selectLessons(lessons, node) {
  const list = Array.isArray(lessons) ? lessons : []
  const tokens = lessonTokens(node)
  const picked = []
  for (const lesson of list) {
    if (lesson === null || typeof lesson !== 'object') continue
    if (typeof lesson.id !== 'string' || lesson.id === '') continue
    const explicit = lessonExplicitTargets(lesson)
    const match = explicit.length > 0
      ? explicit.some((token) => tokens.includes(token))
      : tokens.length > 0 && tokens.some((token) => lessonText(lesson).includes(token))
    if (!match) continue
    picked.push({ id: lesson.id, title: typeof lesson.title === 'string' ? lesson.title : '' })
    if (picked.length >= MAX_LESSONS) break
  }
  return picked
}

/** 该节点的门禁命令；图里没写就是空数组（缺省 ≠ 不存在命令）。 */
function gateCommands(node) {
  if (node === null || typeof node !== 'object' || !Array.isArray(node.gateCommands)) return []
  const commands = []
  for (const command of node.gateCommands) {
    if (typeof command !== 'string') continue
    const clean = command.trim()
    if (clean !== '') commands.push(clean)
  }
  return commands
}

/**
 * 给出本轮该做的那**一个**节点。
 *
 * 决策顺序（先停后派）：
 * 1. 全绿 → `{stop:true, reason:'complete'}`（没有可推进的阶段了）。
 * 2. 预算越限 → `{stop:true, reason:<三条之一>}`。
 * 3. C3 越序 → 回补被越序节点的上游，`why` 说明这是回补。
 * 4. 其余 → 前沿里按（层序, 节点序）取最早的一个，保证同一份判定两次派发结果一致。
 * 5. 前沿为空且未全绿 → `{stop:true, reason:'noFrontier'}`。
 *
 * @param {{verdict?: object, graph?: object, lessons?: object[], budget?: Budget}} input
 * @returns {{node: object|null, nodeId: string|null, why: string, lessons: {id:string,title:string}[], gates: string[], stop: boolean, reason?: string}}
 */
export function planStep({ verdict, graph, lessons, budget } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const layers = Array.isArray(graph?.layers) ? graph.layers : []

  const byId = new Map()
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    if (typeof node.id !== 'string' || node.id === '') continue
    byId.set(node.id, node)
  }

  const view = readVerdict(verdict)

  if (allSatisfied(view, nodes)) return stopPlan('complete', '所有节点都已满足，没有可推进的阶段')

  const exhausted = budgetStopReason(budget)
  if (exhausted !== null) return stopPlan(exhausted, `预算已用尽（${exhausted}），不再派发新阶段`)

  if (nodes.length === 0) return stopPlan('noFrontier', '图里没有节点，无从派发')

  const backfill = pickBackfill(view, edges, byId)
  if (backfill !== null) {
    const node = backfill.node
    return {
      node,
      nodeId: node.id,
      why: backfill.why,
      lessons: selectLessons(lessons, node),
      gates: gateCommands(node),
      stop: false,
    }
  }

  const layerOrder = new Map()
  layers.forEach((layer, index) => {
    if (layer === null || typeof layer !== 'object') return
    layerOrder.set(layer.id, Number.isFinite(layer.order) ? layer.order : index)
  })
  const rank = (id) => {
    const node = byId.get(id)
    const layer = layerOrder.has(node.layer) ? layerOrder.get(node.layer) : Number.MAX_SAFE_INTEGER
    const order = Number.isFinite(node.order) ? node.order : 0
    return [layer, order, id]
  }
  const candidates = view.frontier.filter((id) => byId.has(id))
  if (candidates.length === 0) {
    return stopPlan('noFrontier', '前沿为空（或前沿里的节点都不在图里）且未全绿，本轮无节点可推进')
  }
  candidates.sort((a, b) => {
    const left = rank(a)
    const right = rank(b)
    return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2])
  })

  const node = byId.get(candidates[0])
  return {
    node,
    nodeId: node.id,
    why: `前沿里按（层序, 节点序）最早的可推进节点：${node.id}`,
    lessons: selectLessons(lessons, node),
    gates: gateCommands(node),
    stop: false,
  }
}

/**
 * 锚点可追溯性：`anchors[].path` 必须真实存在，证据才收。
 *
 * `exists(path)` 由调用方注入（宿主给真实 fs,测试给内存集合），本函数不碰磁盘。
 * 空 anchors 视为通过（没有锚点要验，不是"有锚点但不合格"）。
 * 拿不到路径的锚点（非对象、空 path）一律算缺失——宁可拒收，不可放行无锚证据。
 * `exists` 抛错（权限、IO）同样算缺失：验不了就不收。
 *
 * @param {Array<{path?: string}|string>|null} anchors
 * @param {{exists: (path: string) => boolean}} options
 * @returns {{ok: boolean, missing: string[]}}
 */
export function verifyAnchors(anchors, { exists } = {}) {
  if (typeof exists !== 'function') throw new TypeError('verifyAnchors 需要注入 exists(path)')

  const list = Array.isArray(anchors) ? anchors : []
  const missing = []
  const seen = new Set()
  for (const anchor of list) {
    const raw = typeof anchor === 'string' ? anchor : anchor !== null && typeof anchor === 'object' ? anchor.path : ''
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (seen.has(path)) continue
    seen.add(path)
    let present = false
    if (path !== '') {
      try {
        present = Boolean(exists(path))
      } catch {
        present = false
      }
    }
    if (!present) missing.push(path)
  }
  return { ok: missing.length === 0, missing }
}

/** 把错误压成可上报的一行细节。 */
function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}

/** 统一结果形状：五个字段常在，`detail` 只在出错时出现。 */
function stageResult(fields) {
  const result = {
    ok: fields.ok === true,
    sessionId: typeof fields.sessionId === 'string' && fields.sessionId !== '' ? fields.sessionId : null,
    progress: fields.progress !== null && typeof fields.progress === 'object' ? fields.progress : null,
    stop: fields.stop === true,
    reason: typeof fields.reason === 'string' ? fields.reason : null,
  }
  if (typeof fields.detail === 'string') result.detail = fields.detail
  return result
}

/**
 * 一次跑一个阶段。**只跑一个**——循环属于调用方（宿主），不属于内核。
 *
 * `startStage({node, lessons, gates})` 由调用方注入，返回
 * `{sessionId, status:'ok'|'failed', progress:{satisfied,total}}`。
 *
 * 记账纪律：任何一次真正发起的尝试（成功 / status 失败 / 抛错 / 返回值坏掉）
 * 都记一次 `spendStage()`，否则一个总是抛错的 `startStage` 会让外层循环停不下来；
 * 抛错与返回值坏掉同时记一次"无进展"（它们确实没带来进展）。
 */
export class StageRunner {
  /**
   * @param {{startStage: Function, clock?: () => number, budget?: Budget, report?: Function}} options
   */
  constructor({ startStage, clock, budget, report } = {}) {
    if (typeof startStage !== 'function') throw new TypeError('StageRunner 需要注入 startStage')
    this.startStage = startStage
    this.clock = typeof clock === 'function' ? clock : Date.now
    this.budget = budget !== null && typeof budget === 'object' ? budget : null
    this.report = typeof report === 'function' ? report : null
  }

  /** 交给上报钩子的时间戳；时钟坏了也不许弄停执行。 */
  isoNow() {
    try {
      const value = this.clock()
      const date = value instanceof Date ? value : new Date(Number.isFinite(value) ? value : Date.now())
      return date.toISOString()
    } catch {
      return new Date().toISOString()
    }
  }

  /** 上报一次运行；观测者抛错不许弄坏阶段结果。 */
  emit(record) {
    if (this.report === null) return
    try {
      this.report(record)
    } catch {
      /* 观测是观测，不是判据 */
    }
  }

  /** 读预算闸；没有预算就是"不停"。 */
  readBudget() {
    if (this.budget === null || typeof this.budget.check !== 'function') return null
    const verdict = this.budget.check()
    if (verdict === null || typeof verdict !== 'object') return null
    return { stop: verdict.stop === true, reason: typeof verdict.reason === 'string' ? verdict.reason : 'budget' }
  }

  /** 记一次阶段消耗 + 一次进度读数。 */
  charge(progress) {
    if (this.budget === null) return
    if (typeof this.budget.spendStage === 'function') this.budget.spendStage()
    if (typeof this.budget.noteProgress === 'function') this.budget.noteProgress(progress)
  }

  /** 跑完后再问一次预算：本轮恰好把闸撞上时，告诉调用方该停了。 */
  settle(outcome) {
    const after = this.readBudget()
    if (after !== null && after.stop === true) {
      return { ...outcome, stop: true, reason: outcome.reason ?? after.reason, budgetReason: after.reason }
    }
    return { ...outcome, stop: false }
  }

  /**
   * @param {{node?: object, lessons?: object[], gates?: string[], stop?: boolean, reason?: string}} plan
   * @returns {Promise<{ok:boolean, sessionId:string|null, progress:{satisfied:number,total:number}|null, stop:boolean, reason:string|null, detail?:string}>}
   */
  async run(plan) {
    const source = plan !== null && typeof plan === 'object' ? plan : null
    if (source === null) {
      return stageResult({ ok: false, stop: true, reason: 'noNode' })
    }
    if (source.stop === true) {
      return stageResult({ ok: false, stop: true, reason: typeof source.reason === 'string' ? source.reason : 'noFrontier' })
    }
    const node = source.node !== null && typeof source.node === 'object' ? source.node : null
    if (node === null || typeof node.id !== 'string' || node.id === '') {
      return stageResult({ ok: false, stop: true, reason: 'noNode' })
    }

    const before = this.readBudget()
    if (before !== null && before.stop === true) {
      return stageResult({ ok: false, stop: true, reason: before.reason })
    }

    const payload = {
      node,
      lessons: Array.isArray(source.lessons) ? source.lessons : [],
      gates: Array.isArray(source.gates) ? source.gates : [],
    }

    let raw
    try {
      raw = await this.startStage(payload)
    } catch (error) {
      this.charge(null)
      const outcome = stageResult({ ok: false, stop: false, reason: 'stageError', detail: describeError(error) })
      const settled = this.settle(outcome)
      this.emit({ node: node.id, ok: false, status: 'error', sessionId: null, progress: null, stop: settled.stop, reason: 'stageError', detail: outcome.detail, at: this.isoNow() })
      return settled
    }

    if (raw === null || typeof raw !== 'object') {
      this.charge(null)
      const outcome = stageResult({ ok: false, stop: false, reason: 'stageError', detail: 'startStage 未返回对象' })
      const settled = this.settle(outcome)
      this.emit({ node: node.id, ok: false, status: 'error', sessionId: null, progress: null, stop: settled.stop, reason: 'stageError', detail: outcome.detail, at: this.isoNow() })
      return settled
    }

    const status = raw.status === 'failed' ? 'failed' : 'ok'
    const sessionId = typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null
    const progress = normalizeProgress(raw.progress)
    this.charge(progress)

    const outcome = stageResult({
      ok: status === 'ok',
      sessionId,
      progress,
      stop: false,
      reason: status === 'ok' ? null : 'stageFailed',
    })
    const settled = this.settle(outcome)
    this.emit({ node: node.id, ok: outcome.ok, status, sessionId, progress, stop: settled.stop, reason: settled.reason, at: this.isoNow() })
    return settled
  }
}
