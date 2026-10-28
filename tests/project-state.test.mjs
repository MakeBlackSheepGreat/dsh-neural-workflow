#!/usr/bin/env node
/**
 * 项目状态的测试。
 *
 * 锁住六件事：原子写走 tmp+rename、load/save 往返一致、claim 挂上非 failure
 * 证据才变 supported、failure 证据只记录不支撑、run 登记与终态关账、
 * 坏 JSON 容错（空态 + skipped + 可恢复）。
 * 状态文件用临时目录里的真文件，时间用注入的假时钟——不依赖真实时间与 DSH_HOME。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { projectKey, projectStatePath, ProjectState } from '../lib/project-state.js'
import { projectKey as experienceProjectKey } from '../lib/experience.js'

/** 在临时目录里造一个状态文件；now() 每次调用前进 1 秒，便于断言时间来自注入。 */
function makeState(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const start = options.start ?? Date.UTC(2026, 0, 1)
  let tick = 0
  const now = options.now ?? (() => new Date(start + tick++ * 1000))
  return { dir, file, now, state: new ProjectState({ file, now }) }
}

/** 直接读盘上的 state.json（绕过内存态，验证每次变更都落了盘）。 */
function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('projectStatePath：落在 <dshHome>/neural-workflow/projects/<key>/state.json，与经验账本同一 projectKey', () => {
  const target = projectStatePath('/home/u/.dsh', '/work/neural-paper')
  assert.equal(
    target,
    path.join('/home/u/.dsh', 'neural-workflow', 'projects', projectKey('/work/neural-paper'), 'state.json'),
  )
  // 关键一致性：state.json 与 experience.ndjson 必须在同一个 project 目录里。
  assert.equal(
    path.basename(path.dirname(target)),
    experienceProjectKey('/work/neural-paper'),
  )
  assert.throws(() => projectStatePath('', '/work'), TypeError)
})

test('addClaim：claim-<n> 自增、默认 open，且变更立即落盘', (t) => {
  const { file, state } = makeState(t)
  const first = state.addClaim({ text: 'P3 经验生命周期已完成', node: 'develop' })
  assert.equal(first.id, 'claim-1')
  assert.equal(first.text, 'P3 经验生命周期已完成')
  assert.equal(first.node, 'develop')
  assert.equal(first.status, 'open')
  assert.deepEqual(first.evidence, [])
  assert.equal(first.createdAt, '2026-01-01T00:00:00.000Z')

  const second = state.addClaim({ text: 'P4 执行器内核已完成', node: 'train' })
  assert.equal(second.id, 'claim-2')
  assert.equal(second.createdAt, '2026-01-01T00:00:01.000Z')

  // 落盘校验：每次 addClaim 都原子写了全量快照。
  assert.equal(state.claims().length, 2)
  const onDisk = readState(file)
  assert.equal(onDisk.claims.length, 2)
  assert.equal(onDisk.counters.claim, 2)

  assert.throws(() => state.addClaim({ text: '  ', node: 'x' }), TypeError)
  assert.throws(() => state.addClaim({ text: 'x' }), TypeError)
})

test('linkEvidence：非 failure 证据让 claim open → supported，failure 不行', (t) => {
  const { state } = makeState(t)
  const claim = state.addClaim({ text: '升格门槛已测试覆盖', node: 'validate' })

  // 先挂 failure 证据：照记，但 claim 仍是 open。
  const afterFailure = state.linkEvidence(claim.id, {
    node: 'validate',
    kind: 'failure',
    note: '测试跑挂了一次',
    anchors: [{ path: 'tests/experience.test.mjs', note: '第 2 轮失败' }],
  })
  assert.equal(afterFailure.status, 'open')
  assert.equal(afterFailure.evidence.length, 1)
  assert.equal(afterFailure.evidence[0].kind, 'failure')
  assert.equal(afterFailure.evidence[0].at, '2026-01-01T00:00:01.000Z')

  // 再挂一条非 failure 证据：整个 evidence 里存在非 failure → supported。
  const afterGate = state.linkEvidence(claim.id, { node: 'validate', kind: 'gate' })
  assert.equal(afterGate.status, 'supported')
  assert.equal(afterGate.evidence.length, 2)

  // supported 是单调的：再补 failure 证据也不会打回 open。
  const afterMore = state.linkEvidence(claim.id, { node: 'validate', kind: 'failure' })
  assert.equal(afterMore.status, 'supported')
})

test('linkEvidence：evidence 校验与未知 claim id 抛错', (t) => {
  const { state } = makeState(t)
  assert.throws(() => state.linkEvidence('claim-missing', { node: 'x', kind: 'gate' }), /未知 claim id/)
  const claim = state.addClaim({ text: '校验用', node: 'develop' })
  assert.throws(() => state.linkEvidence(claim.id, { node: 'x' }), /kind/)
  assert.throws(() => state.linkEvidence(claim.id, { kind: 'gate' }), /node/)
  assert.equal(state.claims()[0].evidence.length, 0)
})

test('run 登记：recordRun 默认 running，finishRun 写终态与 finishedAt', (t) => {
  const { file, state } = makeState(t)
  const run = state.recordRun({ node: 'train', sessionId: 'sess-a', progress: { satisfied: 0, total: 3 } })
  assert.equal(run.id, 'run-1')
  assert.equal(run.status, 'running')
  assert.equal(run.startedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(run.progress, { satisfied: 0, total: 3 })
  assert.equal(run.finishedAt, undefined)

  const finished = state.finishRun(run.id, { status: 'ok', progress: { satisfied: 3, total: 3 } })
  assert.equal(finished.status, 'ok')
  assert.equal(finished.finishedAt, '2026-01-01T00:00:01.000Z')
  assert.deepEqual(finished.progress, { satisfied: 3, total: 3 })

  // 第二条 run：finishRun 不带 progress 时保留登记时的值。
  const second = state.recordRun({ node: 'write', sessionId: 'sess-b' })
  assert.equal(second.id, 'run-2')
  const failed = state.finishRun(second.id, { status: 'failed' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.progress, undefined)

  const onDisk = readState(file)
  assert.equal(onDisk.runs.length, 2)
  assert.equal(onDisk.counters.run, 2)

  assert.throws(() => state.finishRun('run-missing', { status: 'ok' }), /未知 run id/)
  assert.throws(() => state.finishRun(run.id, { status: 'running' }), /终态/)
  assert.throws(() => state.recordRun({ sessionId: 's', status: 'paused' }), RangeError)
  assert.throws(() => state.recordRun({ node: 'train' }), TypeError)
})

test('原子写：先写 <file>.tmp 再 rename 覆盖，落盘后不留 tmp', (t) => {
  const { file, state } = makeState(t)
  const renames = []
  const originalRename = fs.renameSync
  const mocked = mock.method(fs, 'renameSync', (from, to) => {
    renames.push([from, to])
    return originalRename.call(fs, from, to)
  })
  t.after(() => mocked.mock.restore())

  state.addClaim({ text: '原子写', node: 'develop' })
  assert.equal(renames.length, 1)
  assert.equal(renames[0][0], `${file}.tmp`)
  assert.equal(renames[0][1], file)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  assert.equal(readState(file).claims[0].text, '原子写')

  // rename 是覆盖语义：二次写入替换旧快照，而不是追加。
  state.addClaim({ text: '第二条', node: 'train' })
  assert.equal(renames.length, 2)
  assert.equal(readState(file).claims.length, 2)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('原子写：残留的坏 tmp 不影响 state.json，下次写入直接覆盖', (t) => {
  const { file, state } = makeState(t)
  fs.writeFileSync(`${file}.tmp`, '{写了一半的垃圾', 'utf8')
  state.addClaim({ text: 'tmp 残留无关', node: 'develop' })
  assert.equal(readState(file).claims[0].text, 'tmp 残留无关')
  assert.equal(fs.existsSync(`${file}.tmp`), false)
})

test('load/save 往返：新实例从盘上折出同一份 claims 与 runs', (t) => {
  const { file, state } = makeState(t)
  const claim = state.addClaim({ text: '跨会话声明', node: 'conclude' })
  state.linkEvidence(claim.id, { node: 'conclude', kind: 'test', note: '测试绿', anchors: [{ path: 'tests/x.mjs' }] })
  const run = state.recordRun({ node: 'conclude', sessionId: 'sess-c', status: 'running' })
  state.finishRun(run.id, { status: 'ok', progress: { satisfied: 1, total: 1 } })

  const reloaded = new ProjectState({ file, now: () => new Date('2026-06-01T00:00:00Z') })
  assert.deepEqual(reloaded.load(), { loaded: 2, skipped: 0 })
  assert.deepEqual(reloaded.claims(), state.claims())
  assert.deepEqual(reloaded.runs(), state.runs())

  // 往返之后计数器不回退：新 claim/run 接着往后编号。
  assert.equal(reloaded.addClaim({ text: '接续编号', node: 'develop' }).id, 'claim-2')
  assert.equal(reloaded.recordRun({ node: 'develop', sessionId: 'sess-d' }).id, 'run-2')
})

test('坏 JSON 容错：空态 + skipped，不抛；下一次写入可恢复', (t) => {
  const { file, state } = makeState(t)
  fs.writeFileSync(file, '{"claims": [写坏了', 'utf8')

  const broken = new ProjectState({ file, now: () => new Date('2026-02-01T00:00:00Z') })
  assert.deepEqual(broken.load(), { loaded: 0, skipped: 1 })
  assert.deepEqual(broken.claims(), [])
  assert.deepEqual(broken.runs(), [])

  // 容错之后能继续工作：新写入覆盖坏文件，再加载就是干净状态。
  const recovered = broken.addClaim({ text: '坏盘恢复', node: 'develop' })
  assert.equal(recovered.id, 'claim-1')
  const cold = new ProjectState({ file, now: () => new Date() })
  assert.deepEqual(cold.load(), { loaded: 1, skipped: 0 })
  assert.equal(cold.claims()[0].text, '坏盘恢复')
})

test('load：非对象 JSON 与坏条目也计 skipped，好条目照常加载', (t) => {
  const { file } = makeState(t)
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      claims: [
        { id: 'claim-9', text: '手写的旧声明', node: 'train', status: 'supported', evidence: [] },
        { text: '没有 id' },
        '不是对象',
      ],
      runs: [{ id: 'run-9', node: 'train', sessionId: 's', status: 'ok', startedAt: '2026-01-01T00:00:00Z' }],
      counters: { claim: 9, run: 9 },
    }),
    'utf8',
  )

  const state = new ProjectState({ file, now: () => new Date() })
  assert.deepEqual(state.load(), { loaded: 2, skipped: 2 })
  assert.equal(state.claims()[0].id, 'claim-9')
  assert.equal(state.claims()[0].status, 'supported')
  // 手写的大序号被采纳：新条目不撞旧 id。
  assert.equal(state.addClaim({ text: '接着 9 往后', node: 'develop' }).id, 'claim-10')
})

test('claims()/runs() 返回副本，外部改动不会污染内存态', (t) => {
  const { state } = makeState(t)
  state.addClaim({ text: '副本测试', node: 'develop' })
  const run = state.recordRun({ node: 'develop', sessionId: 's' })
  state.finishRun(run.id, { status: 'ok' })

  const [claimCopy] = state.claims()
  claimCopy.status = 'supported'
  claimCopy.text = '被改了'
  const [runCopy] = state.runs()
  runCopy.status = 'failed'

  assert.equal(state.claims()[0].status, 'open')
  assert.equal(state.claims()[0].text, '副本测试')
  assert.equal(state.runs()[0].status, 'ok')
})

test('时间来自注入的 now()，数字时间戳同样接受', (t) => {
  const { file, state } = makeState(t)
  const times = ['2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z']
  let index = 0
  const injected = new ProjectState({ file, now: () => new Date(times[index++]) })

  const claim = injected.addClaim({ text: '固定时间', node: 'develop' })
  assert.equal(claim.createdAt, '2026-03-01T00:00:00.000Z')
  const linked = injected.linkEvidence(claim.id, { node: 'develop', kind: 'gate' })
  assert.equal(linked.evidence[0].at, '2026-03-02T00:00:00.000Z')
  assert.equal(linked.status, 'supported')

  // 数字时间戳注入：run 时间戳归一成 ISO。
  const numeric = new ProjectState({ file, now: () => 1_772_000_000_000 })
  assert.equal(numeric.recordRun({ node: 'train', sessionId: 's' }).startedAt, '2026-02-25T06:13:20.000Z')
})
