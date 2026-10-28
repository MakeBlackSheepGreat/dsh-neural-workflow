#!/usr/bin/env node
/**
 * 执行器内核测试。
 *
 * 重点不在覆盖率，在三条硬要求：
 * 1. **三条停机各自可达**，且原因能说清是哪一条——停机错了比不停更贵（会白烧预算）。
 * 2. **派发是确定的**：同一份判定派两次必须挑同一个节点，否则复盘无从谈起。
 * 3. **锚点校验不许碰磁盘**：`exists` 注入，测试给内存集合，内核不认识 fs。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveBudget, Budget, planStep, verifyAnchors, StageRunner } from '../lib/executor.js'
import { GRAPH_DOC } from '../lib/graph.js'

/** 小图：L0 scope → L1 train → L1 validate → L2 write，只留派发需要的最小字段。 */
function chainGraph() {
  return {
    layers: [
      { id: 'L0', order: 0 },
      { id: 'L1', order: 1 },
      { id: 'L2', order: 2 },
    ],
    nodes: [
      { id: 'scope', layer: 'L0', order: 10, name: { zh: '研究范围', en: 'Scope' } },
      { id: 'train', layer: 'L1', order: 10, name: { zh: '训练', en: 'Train' } },
      { id: 'validate', layer: 'L1', order: 30, name: { zh: '验证', en: 'Validate' } },
      { id: 'write', layer: 'L2', order: 20, name: { zh: '写作', en: 'Write' }, gateCommands: ['npm test', '   '] },
    ],
    edges: [
      { from: 'scope', to: 'train' },
      { from: 'train', to: 'validate' },
      { from: 'validate', to: 'write' },
    ],
  }
}

/** 手摇时钟：测试不依赖真实时间。 */
function fakeClock(start = 1_700_000_000_000) {
  const state = { value: start }
  return { now: () => state.value, advance: (ms) => { state.value += ms } }
}

const DEFAULT_LIMITS = { maxStages: 6, maxWallMs: 2_700_000, maxConsecutiveNoProgress: 2 }

test('resolveBudget：缺省给默认值', () => {
  assert.deepEqual(resolveBudget(undefined), DEFAULT_LIMITS)
  assert.deepEqual(resolveBudget(null), DEFAULT_LIMITS)
  assert.deepEqual(resolveBudget({}), DEFAULT_LIMITS)
  assert.deepEqual(resolveBudget('nope'), DEFAULT_LIMITS)
})

test('resolveBudget：数字越界夹取，非数字回落默认值', () => {
  assert.deepEqual(resolveBudget({ maxStages: 0, maxWallMs: -5, maxConsecutiveNoProgress: 999 }), {
    maxStages: 1,
    maxWallMs: 1000,
    maxConsecutiveNoProgress: 20,
  })
  assert.deepEqual(resolveBudget({ maxStages: 10_000 }), { ...DEFAULT_LIMITS, maxStages: 50 })
  assert.deepEqual(resolveBudget({ maxStages: Number.POSITIVE_INFINITY }), { ...DEFAULT_LIMITS, maxStages: 50 })
  // 字符串不是数字：意图不明就不猜，回落默认值。
  assert.deepEqual(resolveBudget({ maxStages: '9', maxWallMs: Number.NaN, maxConsecutiveNoProgress: undefined }), DEFAULT_LIMITS)
  // 小数取整后再夹。
  assert.deepEqual(resolveBudget({ maxStages: 2.6 }), { ...DEFAULT_LIMITS, maxStages: 3 })
})

test('Budget：新预算不停机', () => {
  const budget = new Budget(DEFAULT_LIMITS, { now: () => 0 })
  assert.deepEqual(budget.check(), { stop: false })
})

test('Budget：maxStages 触发', () => {
  const budget = new Budget({ maxStages: 2, maxWallMs: 60_000, maxConsecutiveNoProgress: 20 }, { now: () => 0 })
  budget.spendStage()
  assert.equal(budget.check().stop, false)
  budget.spendStage()
  assert.deepEqual(budget.check(), { stop: true, reason: 'maxStages' })
})

test('Budget：maxWallMs 触发', () => {
  const clock = fakeClock()
  const budget = new Budget({ maxStages: 50, maxWallMs: 5000, maxConsecutiveNoProgress: 20 }, { now: clock.now })
  assert.equal(budget.check().stop, false)
  clock.advance(4999)
  assert.equal(budget.check().stop, false)
  clock.advance(1)
  assert.deepEqual(budget.check(), { stop: true, reason: 'maxWallMs' })
})

test('Budget：连续无进展计数、有进展归零、到阈值停', () => {
  const budget = new Budget({ maxStages: 50, maxWallMs: 60_000, maxConsecutiveNoProgress: 2 }, { now: () => 0 })

  // 第一次读数只立基线，不算"无进展"。
  assert.equal(budget.noteProgress({ satisfied: 1, total: 5 }), 0)
  assert.equal(budget.noteProgress({ satisfied: 1, total: 5 }), 1)
  assert.equal(budget.check().stop, false)

  // 有进展 → 归零。
  assert.equal(budget.noteProgress({ satisfied: 2, total: 5 }), 0)
  // total 变了也算有进展（总数从别处涨上来说明账本动过）。
  assert.equal(budget.noteProgress({ satisfied: 2, total: 6 }), 0)

  assert.equal(budget.noteProgress({ satisfied: 2, total: 6 }), 1)
  assert.equal(budget.noteProgress({ satisfied: 2, total: 6 }), 2)
  assert.deepEqual(budget.check(), { stop: true, reason: 'noProgress' })
})

test('Budget：坏进度不产 NaN，按 0 计', () => {
  const budget = new Budget(DEFAULT_LIMITS, { now: () => 0 })
  budget.noteProgress(null)
  assert.deepEqual(budget.lastProgress, { satisfied: 0, total: 0 })
  budget.noteProgress({ satisfied: 'x', total: undefined })
  assert.equal(budget.consecutiveNoProgress, 1)
})

test('planStep：frontier 为空且未全绿 → noFrontier', () => {
  const plan = planStep({
    verdict: { frontier: [], progress: { satisfied: 2, total: 4 } },
    graph: chainGraph(),
    lessons: [],
    budget: null,
  })
  assert.equal(plan.stop, true)
  assert.equal(plan.reason, 'noFrontier')
  assert.equal(plan.node, null)
  assert.deepEqual(plan.lessons, [])
  assert.deepEqual(plan.gates, [])
})

test('planStep：全绿 → complete，不再派发', () => {
  const plan = planStep({ verdict: { frontier: [], progress: { satisfied: 4, total: 4 } }, graph: chainGraph() })
  assert.equal(plan.stop, true)
  assert.equal(plan.reason, 'complete')
  assert.equal(plan.node, null)
})

test('planStep：判定缺失不炸，按 noFrontier 停', () => {
  const plan = planStep({ verdict: null, graph: chainGraph() })
  assert.equal(plan.stop, true)
  assert.equal(plan.reason, 'noFrontier')
})

test('planStep：无参调用不炸', () => {
  const plan = planStep()
  assert.equal(plan.stop, true)
  assert.equal(plan.reason, 'noFrontier')
})

test('planStep：C3 越序 → 回补上游节点', () => {
  const plan = planStep({
    verdict: {
      frontier: ['scope'],
      progress: { satisfied: 1, total: 4 },
      nodes: { scope: { state: 'satisfied' }, train: { state: 'ready' }, validate: { state: 'blocked' } },
      violations: [{ code: 'OUT_OF_ORDER', constraint: 'C3', node: 'validate', message: '越序' }],
    },
    graph: chainGraph(),
  })
  assert.equal(plan.stop, false)
  assert.equal(plan.node.id, 'train')
  assert.equal(plan.nodeId, 'train')
  assert.match(plan.why, /回补/)
  assert.match(plan.why, /越序/)
})

test('planStep：真实图上按 constraint/code 两种写法都能认出 C3', () => {
  const byConstraint = planStep({
    verdict: {
      progress: { satisfied: 1, total: 10 },
      frontier: ['develop'],
      violations: [{ constraint: 'C3', node: 'infer', code: 'OUT_OF_ORDER' }],
    },
    graph: GRAPH_DOC,
  })
  assert.equal(byConstraint.node.id, 'train')

  const byCode = planStep({
    verdict: {
      progress: { satisfied: 1, total: 10 },
      frontier: ['develop'],
      violations: [{ code: 'OUT_OF_ORDER', node: 'infer', constraint: '' }],
    },
    graph: GRAPH_DOC,
  })
  assert.equal(byCode.node.id, 'train')
})

test('planStep：非 C3 违规不改变派发目标', () => {
  const plan = planStep({
    verdict: {
      frontier: ['train'],
      progress: { satisfied: 1, total: 4 },
      violations: [{ code: 'KIND_NOT_ACCEPTED', constraint: 'C2', node: 'validate' }],
    },
    graph: chainGraph(),
  })
  assert.equal(plan.node.id, 'train')
})

test('planStep：前沿按（层序, 节点序）取最早，结果确定', () => {
  const verdict = { frontier: ['write', 'validate', 'train'], progress: { satisfied: 1, total: 4 } }
  const first = planStep({ verdict, graph: chainGraph() })
  const second = planStep({ verdict, graph: chainGraph() })
  assert.equal(first.node.id, 'train')
  assert.equal(second.node.id, 'train')
  assert.equal(first.why, second.why)
})

test('planStep：gates 取 gateCommands 并清掉空白项，缺省空数组', () => {
  const write = planStep({ verdict: { frontier: ['write'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph() })
  assert.deepEqual(write.gates, ['npm test'])
  const train = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph() })
  assert.deepEqual(train.gates, [])
})

test('planStep：经验按节点过滤，显式目标优先于正文偶合', () => {
  const lessons = [
    { id: 'exp-1', title: '训练前固定随机种子', body: 'seed 写进配置' },
    { id: 'exp-2', title: '图表字体', body: '字号与参考图一致' },
    { id: 'exp-3', title: '通用检查', body: '每次 train 之后刷新日志' },
    { id: 'exp-4', title: '显式指定', body: '正文不提节点名', node: 'train' },
    { id: 'exp-5', title: '显式指向别的节点', body: 'train 只是举例', node: 'figure' },
    { id: '', title: '没有 id，丢' },
    { title: '不是对象外的坏形状', body: 'train' },
    null,
  ]
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph(), lessons })
  assert.deepEqual(plan.lessons.map((item) => item.id), ['exp-1', 'exp-3', 'exp-4'])
  assert.deepEqual(plan.lessons[0], { id: 'exp-1', title: '训练前固定随机种子' })
})

test('planStep：预算已越限时优先停机，不给节点', () => {
  const budget = new Budget({ maxStages: 1, maxWallMs: 60_000, maxConsecutiveNoProgress: 20 }, { now: () => 0 })
  budget.spendStage()
  const plan = planStep({
    verdict: { frontier: ['train'], progress: { satisfied: 1, total: 4 } },
    graph: chainGraph(),
    budget,
  })
  assert.equal(plan.stop, true)
  assert.equal(plan.reason, 'maxStages')
  assert.equal(plan.node, null)
})

test('verifyAnchors：空 anchors 视为通过', () => {
  assert.deepEqual(verifyAnchors([], { exists: () => false }), { ok: true, missing: [] })
  assert.deepEqual(verifyAnchors(null, { exists: () => false }), { ok: true, missing: [] })
  assert.deepEqual(verifyAnchors(undefined, { exists: () => false }), { ok: true, missing: [] })
})

test('verifyAnchors：缺失路径进 missing，重复路径只报一次', () => {
  const present = new Set(['notes/h.md', 'data/corpus/'])
  const exists = (path) => present.has(path)
  assert.deepEqual(
    verifyAnchors([{ path: 'notes/h.md' }, { path: 'data/corpus/' }], { exists }),
    { ok: true, missing: [] },
  )
  const result = verifyAnchors([{ path: 'notes/h.md' }, { path: 'missing/a.json' }, { path: 'missing/a.json' }], { exists })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['missing/a.json'])
})

test('verifyAnchors：字符串锚点与空路径', () => {
  const exists = (path) => path === 'a'
  assert.deepEqual(verifyAnchors(['a'], { exists }), { ok: true, missing: [] })
  // 拿不到路径的锚点算缺失：宁可拒收，不放行无锚证据。
  const blank = verifyAnchors([{ path: '   ' }, {}], { exists: () => true })
  assert.equal(blank.ok, false)
  assert.deepEqual(blank.missing, [''])
})

test('verifyAnchors：exists 抛错按缺失处理', () => {
  const result = verifyAnchors([{ path: 'a' }], { exists: () => { throw new Error('EACCES') } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['a'])
})

test('verifyAnchors：未注入 exists 直接抛 TypeError', () => {
  assert.throws(() => verifyAnchors([{ path: 'a' }]), TypeError)
  assert.throws(() => verifyAnchors([], {}), TypeError)
})

test('StageRunner：必须注入 startStage', () => {
  assert.throws(() => new StageRunner({}), TypeError)
})

test('StageRunner：一次只跑一个阶段并记账', async () => {
  const calls = []
  const reports = []
  const budget = new Budget(DEFAULT_LIMITS, { now: () => 0 })
  const runner = new StageRunner({
    startStage: async (payload) => {
      calls.push(payload)
      return { sessionId: 's1', status: 'ok', progress: { satisfied: 2, total: 6 } }
    },
    clock: () => 0,
    budget,
    report: (record) => reports.push(record),
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph() })

  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionId, 's1')
  assert.deepEqual(outcome.progress, { satisfied: 2, total: 6 })
  assert.equal(outcome.stop, false)
  assert.equal(outcome.reason, null)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].node.id, 'train')
  assert.deepEqual(calls[0].gates, [])
  assert.deepEqual(calls[0].lessons, [])

  assert.equal(budget.stages, 1)
  assert.deepEqual(budget.lastProgress, { satisfied: 2, total: 6 })
  assert.equal(reports.length, 1)
  assert.equal(reports[0].node, 'train')
  assert.equal(reports[0].status, 'ok')
  assert.equal(reports[0].at, new Date(0).toISOString())
})

test('StageRunner：maxStages 到点后不再起阶段', async () => {
  let started = 0
  const budget = new Budget({ maxStages: 2, maxWallMs: 60_000, maxConsecutiveNoProgress: 20 }, { now: () => 0 })
  const runner = new StageRunner({
    startStage: async () => {
      started += 1
      return { sessionId: `s${started}`, status: 'ok', progress: { satisfied: started, total: 9 } }
    },
    budget,
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })

  const first = await runner.run(plan)
  assert.equal(first.stop, false)

  const second = await runner.run(plan)
  assert.equal(second.ok, true)
  assert.equal(second.stop, true)
  assert.equal(second.reason, 'maxStages')

  const third = await runner.run(plan)
  assert.equal(third.ok, false)
  assert.equal(third.stop, true)
  assert.equal(third.reason, 'maxStages')
  assert.equal(started, 2)
})

test('StageRunner：maxWallMs 到点在跑完后停', async () => {
  const clock = fakeClock()
  const budget = new Budget({ maxStages: 20, maxWallMs: 6000, maxConsecutiveNoProgress: 20 }, { now: clock.now })
  const runner = new StageRunner({
    startStage: async () => {
      clock.advance(7000)
      return { sessionId: 's', status: 'ok', progress: { satisfied: 1, total: 4 } }
    },
    budget,
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })

  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.stop, true)
  assert.equal(outcome.reason, 'maxWallMs')
})

test('StageRunner：连续无进展触发 noProgress', async () => {
  const budget = new Budget({ maxStages: 20, maxWallMs: 60_000, maxConsecutiveNoProgress: 2 }, { now: () => 0 })
  const runner = new StageRunner({
    startStage: async () => ({ sessionId: 's', status: 'ok', progress: { satisfied: 1, total: 4 } }),
    budget,
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph() })

  assert.equal((await runner.run(plan)).stop, false) // 第一次：立基线
  assert.equal((await runner.run(plan)).stop, false) // 第二次：无进展 +1
  const third = await runner.run(plan) // 第三次：无进展 +2 → 停
  assert.equal(third.stop, true)
  assert.equal(third.reason, 'noProgress')
})

test('StageRunner：startStage 抛错 → stageError，且算一次消耗', async () => {
  const budget = new Budget(DEFAULT_LIMITS, { now: () => 0 })
  const runner = new StageRunner({
    startStage: async () => { throw new Error('boom') },
    budget,
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })

  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'stageError')
  assert.equal(outcome.detail, 'boom')
  assert.equal(outcome.sessionId, null)
  assert.equal(outcome.progress, null)
  // 抛错也算一次尝试：否则一个总是抛错的 startStage 让外层循环停不下来。
  assert.equal(budget.stages, 1)
})

test('StageRunner：startStage 返回非对象 → stageError', async () => {
  const runner = new StageRunner({ startStage: async () => undefined })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })
  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'stageError')
  assert.equal(outcome.detail, 'startStage 未返回对象')
})

test('StageRunner：status 为 failed 时 ok:false，但不停机', async () => {
  const runner = new StageRunner({
    startStage: async () => ({ sessionId: 's', status: 'failed', progress: { satisfied: 0, total: 4 } }),
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })
  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'stageFailed')
  assert.equal(outcome.stop, false)
  assert.equal(outcome.sessionId, 's')
})

test('StageRunner：plan 已停或没有节点就不起阶段', async () => {
  let started = 0
  const runner = new StageRunner({
    startStage: async () => {
      started += 1
      return { sessionId: 's', status: 'ok', progress: { satisfied: 1, total: 1 } }
    },
  })

  const stopped = await runner.run({ stop: true, reason: 'noFrontier' })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.stop, true)
  assert.equal(stopped.reason, 'noFrontier')

  const missing = await runner.run(null)
  assert.equal(missing.stop, true)
  assert.equal(missing.reason, 'noNode')

  const noNode = await runner.run({ node: null })
  assert.equal(noNode.stop, true)
  assert.equal(noNode.reason, 'noNode')

  assert.equal(started, 0)
})

test('StageRunner：report 抛错不影响结果', async () => {
  const runner = new StageRunner({
    startStage: async () => ({ sessionId: 's', status: 'ok', progress: { satisfied: 1, total: 4 } }),
    report: () => { throw new Error('观测者坏了') },
  })
  const plan = planStep({ verdict: { frontier: ['train'], progress: { satisfied: 0, total: 4 } }, graph: chainGraph() })
  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionId, 's')
})

test('端到端：派发→跑阶段→预算撞闸，调停原因可见', async () => {
  const budget = new Budget({ maxStages: 1, maxWallMs: 60_000, maxConsecutiveNoProgress: 20 }, { now: () => 0 })
  const runner = new StageRunner({
    startStage: async () => ({ sessionId: 's1', status: 'ok', progress: { satisfied: 2, total: 4 } }),
    budget,
  })
  const plan = planStep({ verdict: { frontier: ['write', 'train'], progress: { satisfied: 1, total: 4 } }, graph: chainGraph() })
  assert.equal(plan.node.id, 'train')

  const outcome = await runner.run(plan)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.stop, true)
  assert.equal(outcome.reason, 'maxStages')
  assert.equal(outcome.budgetReason, 'maxStages')
})
