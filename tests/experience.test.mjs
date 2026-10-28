#!/usr/bin/env node
/**
 * 经验生命周期的测试。
 *
 * 这些测试锁住四件事：trust 阶梯只在"成功用过"时往上走、失败能降级、
 * canonical 不被自动拉下来、矛盾/复发只报告不自动改账本。
 * 账本用临时目录里的真文件，时间用注入的假时钟——不依赖真实时间与 DSH_HOME。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { projectKey, storePath, ExperienceStore } from '../lib/experience.js'

/** 在临时目录里造一个账本；now() 每次调用前进 1 秒，便于断言时间来自注入。 */
function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'experience.ndjson')
  const start = options.start ?? Date.UTC(2026, 0, 1)
  let tick = 0
  const now = options.now ?? (() => new Date(start + tick++ * 1000))
  return { dir, file, now, store: new ExperienceStore({ file, now }) }
}

/** 读账本的非空行（每行一条 JSON）。 */
function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
}

test('projectKey：稳定短哈希，区分不同工作区', () => {
  const key = projectKey('C:/work/neural-paper')
  assert.match(key, /^[0-9a-f]{12}$/)
  assert.equal(key, projectKey('C:/work/neural-paper'))
  assert.notEqual(key, projectKey('C:/work/other'))
  assert.throws(() => projectKey(''), TypeError)
})

test('storePath：落在 <dshHome>/neural-workflow/projects/<key>/', () => {
  const target = storePath('/home/u/.dsh', '/work/neural-paper')
  assert.equal(
    target,
    path.join('/home/u/.dsh', 'neural-workflow', 'projects', projectKey('/work/neural-paper'), 'experience.ndjson'),
  )
})

test('record：追加一行、返回 candidate 快照，重新 load 后一致', (t) => {
  const { file, store } = makeStore(t)
  const written = store.record({
    title: 'AFL 大模型下 loss 膨胀',
    body: '先降学习率并检查 warmup',
    kind: 'lesson',
    scope: { conditions: ['AFL'], ranges: ['lr<=1e-4'] },
    anchors: [{ path: 'runs/afl/train.log', note: '第 3 次复现' }],
  })

  assert.match(written.id, /^exp-[0-9a-f]{12}$/)
  assert.equal(written.standing, 'candidate')
  assert.deepEqual(written.applications, [])
  assert.equal(written.createdAt, '2026-01-01T00:00:00.000Z')

  const lines = readLines(file)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), written)

  // 新实例必须能从盘上折出同一份记录（懒加载也在这一句里生效）。
  const reloaded = new ExperienceStore({ file, now: () => new Date('2026-06-01T00:00:00Z') })
  assert.deepEqual(reloaded.load(), { loaded: 1, skipped: 0 })
  assert.deepEqual(reloaded.all(), [written])
})

test('record：kind 与 title 校验，坏输入直接抛错', (t) => {
  const { store } = makeStore(t)
  assert.throws(() => store.record({ title: 'x', kind: 'hypothesis' }), RangeError)
  assert.throws(() => store.record({ title: '   ', kind: 'lesson' }), TypeError)
  assert.throws(() => store.record({ title: 'x', body: 42, kind: 'lesson' }), TypeError)
})

test('升格门槛：成功应用满 2 次才从 candidate 升 derived', (t) => {
  const { file, store } = makeStore(t)
  const record = store.record({ title: '梯度裁剪后训练稳定', kind: 'lesson' })

  const first = store.feedback(record.id, 'success', '第一次复用')
  assert.equal(first.standing, 'candidate')
  assert.equal(first.applications.length, 1)
  assert.equal(first.applications[0].outcome, 'success')
  assert.equal(first.applications[0].at, '2026-01-01T00:00:01.000Z')

  const second = store.feedback(record.id, 'success', '第二次复用')
  assert.equal(second.standing, 'derived')
  assert.equal(second.applications.length, 2)

  // 回流也走追加写：每次反馈一行，历史行不被改写。
  assert.equal(readLines(file).length, 3)
  const cold = new ExperienceStore({ file, now: () => new Date() })
  assert.deepEqual(cold.load(), { loaded: 1, skipped: 0 })
  assert.equal(cold.all()[0].standing, 'derived')
  assert.equal(cold.all()[0].applications.length, 2)
})

test('失败降级：derived 失败一次回落 candidate，candidate 保持', (t) => {
  const { store } = makeStore(t)
  const record = store.record({ title: '增大 batch 提升吞吐', kind: 'lesson' })
  store.feedback(record.id, 'success')
  store.feedback(record.id, 'success')
  assert.equal(store.all()[0].standing, 'derived')

  const failed = store.feedback(record.id, 'failure', 'OOM 了')
  assert.equal(failed.standing, 'candidate')
  assert.equal(failed.applications.length, 3)
  assert.equal(failed.applications.at(-1).outcome, 'failure')

  // candidate 再失败仍在 candidate，不会"降成负分"。
  assert.equal(store.feedback(record.id, 'failure').standing, 'candidate')
})

test('canonical 只记历史：失败不降级', (t) => {
  const { file, store } = makeStore(t)
  const record = store.record({ title: '锚点路径必须真实存在才入账', kind: 'lesson' })
  store.promote(record.id, 'canonical', { explicit: true })

  const failed = store.feedback(record.id, 'failure', '有人用了旧路径')
  assert.equal(failed.standing, 'canonical')
  assert.equal(failed.applications.length, 1)

  const cold = new ExperienceStore({ file, now: () => new Date() })
  cold.load()
  assert.equal(cold.all()[0].standing, 'canonical')
})

test('explicit 门：canonical 必须人工 explicit:true，promote 不能降级', (t) => {
  const { store } = makeStore(t)
  const record = store.record({ title: '每个实验都写 config_snapshot', kind: 'lesson' })

  assert.throws(() => store.promote(record.id, 'canonical'), /explicit: true/)
  assert.throws(() => store.promote(record.id, 'canonical', { explicit: false }), /explicit: true/)
  assert.throws(() => store.promote(record.id, 'canonical', { explicit: 'yes' }), /explicit: true/)

  // 人工可以把 candidate 直接升 derived（不要求 2 次成功）。
  assert.equal(store.promote(record.id, 'derived').standing, 'derived')
  assert.equal(store.promote(record.id, 'canonical', { explicit: true }).standing, 'canonical')

  // 降级只走 feedback(failure)，promote 不给后门。
  assert.throws(() => store.promote(record.id, 'derived'), /feedback\(failure\)/)
  assert.throws(() => store.promote(record.id, 'blessed'), RangeError)
})

test('未知 id：feedback / promote 抛错，不静默吞掉', (t) => {
  const { store } = makeStore(t)
  assert.throws(() => store.feedback('exp-missing', 'success'), /未知经验 id/)
  assert.throws(() => store.promote('exp-missing', 'derived'), /未知经验 id/)
  assert.throws(() => store.record({ title: 'x', kind: 'lesson' }) && store.feedback('anything', 'maybe'), RangeError)
})

test('矛盾：同 scope 相似标题的 lesson/negative 两方都可见，不自动合并', (t) => {
  const { store } = makeStore(t)
  const lesson = store.record({
    title: 'AFL 下 loss 膨胀时降低学习率',
    body: '降低学习率后曲线恢复',
    kind: 'lesson',
    scope: { conditions: ['AFL'] },
  })
  const negative = store.record({
    title: 'AFL 下 loss 膨胀时降低学习率',
    body: '降低学习率无效，真正原因是标签错位',
    kind: 'negative',
    scope: { conditions: ['AFL'] },
  })

  const pairs = store.contradictions()
  assert.equal(pairs.length, 1)
  assert.deepEqual(pairs[0], [lesson.id, negative.id].sort())

  // 不自动消解：两条都还在，standing 都没被动过。
  assert.equal(store.all().length, 2)
  assert.deepEqual(store.all().map((item) => item.standing), ['candidate', 'candidate'])
})

test('矛盾：不同 scope 或同向结论不算矛盾', (t) => {
  const { store } = makeStore(t)
  // 同标题、不同范围：不是同一适用范围下的对立结论。
  store.record({ title: '增大 batch 提升吞吐', kind: 'lesson', scope: { conditions: ['A100'] } })
  store.record({ title: '增大 batch 提升吞吐', kind: 'negative', scope: { conditions: ['3090'] } })
  assert.deepEqual(store.contradictions(), [])

  // 同 scope、同 kind、同向结论：不构成矛盾。
  store.record({ title: '梯度裁剪后训练稳定', body: '稳定', kind: 'lesson', scope: { conditions: ['SGD'] } })
  store.record({ title: '梯度裁剪后训练稳定', body: '也稳定', kind: 'lesson', scope: { conditions: ['SGD'] } })
  assert.deepEqual(store.contradictions(), [])
})

test('复发：共享锚点跨 3 条才聚类，阈值可配', (t) => {
  const { store } = makeStore(t)
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    const record = store.record({
      title: `OOM：batch ${index}`,
      kind: 'lesson',
      body: '显存峰值随 batch 线性增长',
      anchors: [{ path: 'runs/oom.log' }],
    })
    ids.push(record.id)
  }

  const clusters = store.recurrence()
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].signature, 'anchor:runs/oom.log')
  assert.deepEqual(clusters[0].ids, ids)

  // 只出现 2 次的复发不够阈值。
  const { store: small } = makeStore(t)
  small.record({ title: 'CUDA OOM：a', kind: 'lesson', anchors: [{ path: 'runs/small.log' }] })
  small.record({ title: 'CUDA OOM：b', kind: 'lesson', anchors: [{ path: 'runs/small.log' }] })
  assert.deepEqual(small.recurrence(), [])
  assert.equal(small.recurrence(2).length, 1)
})

test('复发：锚点不同但标题前缀相同也能聚', (t) => {
  const { store } = makeStore(t)
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    const record = store.record({
      title: `显存不足：实验 ${index}`,
      kind: 'negative',
      anchors: [{ path: `runs/mem-${index}/train.log` }],
    })
    ids.push(record.id)
  }
  const clusters = store.recurrence()
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].signature, 'title:显存')
  assert.deepEqual(clusters[0].ids, ids)
})

test('坏行容错：跳过并计数，好行照常加载', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'experience.ndjson')
  const good = {
    id: 'exp-good',
    title: '好记录',
    body: '',
    kind: 'lesson',
    scope: {},
    anchors: [],
    standing: 'candidate',
    createdAt: '2026-01-01T00:00:00.000Z',
    applications: [],
  }
  fs.writeFileSync(
    file,
    [
      JSON.stringify(good),
      '{这不是 JSON',
      '42',
      JSON.stringify({ title: '没有 id' }),
      '',
      JSON.stringify(good), // 重复 id：按快照合并，不是两条
    ].join('\n'),
  )

  const store = new ExperienceStore({ file, now: () => new Date('2026-01-02T00:00:00Z') })
  assert.deepEqual(store.load(), { loaded: 1, skipped: 3 })
  assert.equal(store.skipped, 3)
  assert.deepEqual(store.all().map((item) => item.id), ['exp-good'])
})

test('搜索：中文二元组 + 英文词命中，返回契约字段', (t) => {
  const { store } = makeStore(t)
  const target = store.record({
    title: 'AFL 大模型 loss 膨胀',
    body: '先降低学习率并检查 warmup',
    kind: 'lesson',
    scope: { conditions: ['AFL'] },
  })
  store.record({ title: '锚点路径必须真实存在', body: 'verifyAnchors 拒绝缺失路径', kind: 'lesson' })

  const hits = store.search('loss 学习率')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].id, target.id)
  assert.deepEqual(Object.keys(hits[0]).sort(), ['id', 'kind', 'scope', 'score', 'standing', 'title'])
  assert.equal(hits[0].kind, 'lesson')
  assert.equal(hits[0].standing, 'candidate')
  assert.ok(hits[0].score > 0)

  // 没命中就返回空，不给"看起来相关"的噪声。
  assert.deepEqual(store.search('zzzz qqqq'), [])
  assert.equal(store.search('loss', 1).length, 1)
})

test('搜索：trust 越高加权越大', (t) => {
  const { store } = makeStore(t)
  const a = store.record({ title: 'warmup 步数影响 loss 尖峰', kind: 'lesson' })
  const b = store.record({ title: 'warmup 步数影响 loss 尖峰', kind: 'lesson' })
  store.feedback(b.id, 'success')
  store.feedback(b.id, 'success')
  assert.equal(store.all().find((item) => item.id === b.id).standing, 'derived')

  const hits = store.search('warmup loss')
  assert.equal(hits[0].id, b.id)
  assert.equal(hits[1].id, a.id)
})

test('scope 合并：同 id 的追加行浅合并范围、保住锚点', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'experience.ndjson')
  const first = {
    id: 'exp-merge',
    title: '显存不足：batch 太大',
    body: '降到 32 可跑',
    kind: 'negative',
    scope: { conditions: ['3090'] },
    anchors: [{ path: 'runs/mem.log', note: '峰值 23.8G' }],
    standing: 'candidate',
    createdAt: '2026-01-01T00:00:00.000Z',
    applications: [],
  }
  // 第二行只带范围的一部分，且不带 anchors——合并时不能丢第一行的字段。
  const second = {
    id: 'exp-merge',
    title: '显存不足：batch 太大',
    body: '降到 32 可跑',
    kind: 'negative',
    scope: { units: 'GiB' },
    standing: 'derived',
  }
  fs.writeFileSync(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)

  const store = new ExperienceStore({ file, now: () => new Date('2026-01-03T00:00:00Z') })
  assert.deepEqual(store.load(), { loaded: 1, skipped: 0 })
  const [merged] = store.all()
  assert.deepEqual(merged.scope, { conditions: ['3090'], units: 'GiB' })
  assert.deepEqual(merged.anchors, [{ path: 'runs/mem.log', note: '峰值 23.8G' }])
  assert.equal(merged.standing, 'derived')
  assert.equal(merged.createdAt, '2026-01-01T00:00:00.000Z')
})

test('时间来自注入的 now()，不依赖真实时钟', (t) => {
  const { file } = makeStore(t)
  const times = ['2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z']
  let index = 0
  const store = new ExperienceStore({ file, now: () => new Date(times[index++]) })

  const record = store.record({ title: '固定时间', kind: 'idea' })
  assert.equal(record.createdAt, '2026-03-01T00:00:00.000Z')

  const updated = store.feedback(record.id, 'success', 'ok')
  assert.equal(updated.applications[0].at, '2026-03-02T00:00:00.000Z')

  // 数字时间戳同样接受，并归一成 ISO。
  const numericFile = path.join(path.dirname(file), 'numeric.ndjson')
  const numeric = new ExperienceStore({ file: numericFile, now: () => 1_772_000_000_000 })
  assert.equal(numeric.record({ title: '数字时间', kind: 'lesson' }).createdAt, '2026-02-25T06:13:20.000Z')
})

test('崩溃安全：尾行写坏后仍能追加，且新记录可被再次加载', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'experience.ndjson')
  const good = {
    id: 'exp-good',
    title: '已有的好记录',
    body: '',
    kind: 'lesson',
    scope: {},
    anchors: [],
    standing: 'candidate',
    createdAt: '2026-01-01T00:00:00.000Z',
    applications: [],
  }
  // 模拟写到一半崩溃：最后一行没有换行、也不是完整 JSON。
  fs.writeFileSync(file, `${JSON.stringify(good)}\n{"id":"exp-torn","title":"半行`)

  const store = new ExperienceStore({ file, now: () => new Date('2026-01-04T00:00:00Z') })
  assert.deepEqual(store.load(), { loaded: 1, skipped: 1 })
  const appended = store.record({ title: '修复后新增', kind: 'lesson' })
  assert.ok(appended.id.startsWith('exp-'))

  // 追加时补过换行：坏行独立成行被跳过，新记录不被粘进坏行。
  const cold = new ExperienceStore({ file, now: () => new Date() })
  assert.deepEqual(cold.load(), { loaded: 2, skipped: 1 })
  assert.deepEqual(cold.all().map((item) => item.title), ['已有的好记录', '修复后新增'])
})

test('all() 返回副本，外部改动不会污染账本', (t) => {
  const { store } = makeStore(t)
  store.record({ title: '副本测试', kind: 'lesson' })
  const [copy] = store.all()
  copy.standing = 'canonical'
  copy.title = '被改了'
  assert.equal(store.all()[0].standing, 'candidate')
  assert.equal(store.all()[0].title, '副本测试')
})
