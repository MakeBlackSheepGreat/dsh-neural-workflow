#!/usr/bin/env node
/**
 * 经验回流的测试。
 *
 * 这些测试锁住三件事：草稿折出是对 experience 记录的忠实映射、
 * 重复回流幂等（一致跳过 / 冲突抛错）、升格只在人工 explicit===true
 * 且显式给出 NP 编号时发生——graph 里已有同名条目绝不覆盖。
 * 草稿区与图谱都用 mkdtempSync 临时目录，时间用注入的假时钟。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Backflow, draftFromExperience } from '../lib/backflow.js'

/** 临时目录里的一个回流器；now() 每次调用前进 1 秒，便于断言时间来自注入。 */
function makeBackflow(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backflow-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const draftsDir = path.join(dir, 'drafts')
  const graphDir = path.join(dir, 'graph')
  const start = Date.UTC(2026, 0, 1)
  let tick = 0
  const now = options.now ?? (() => new Date(start + tick++ * 1000))
  return { dir, draftsDir, graphDir, now, backflow: new Backflow({ draftsDir, graphDir, now }) }
}

/** 一条典型的 lesson 经验（字段与 ExperienceStore.record 的产物一致）。 */
function lessonRecord(overrides = {}) {
  return {
    id: 'exp-0a1b2c3d4e5f',
    title: '梯度裁剪后训练稳定',
    body: '先裁剪梯度再检查学习率。学习率过大会复现 loss 膨胀。',
    kind: 'lesson',
    scope: { conditions: ['AFL'] },
    anchors: [{ path: 'runs/afl/train.log', note: '第 3 次复现' }],
    standing: 'candidate',
    applications: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('draftFromExperience：kind 映射、source_event、status 与 draftId 格式', () => {
  const draft = draftFromExperience(lessonRecord())

  assert.match(draft.draftId, /^DRAFT-[0-9a-f]{8}$/)
  assert.equal(draft.title, '梯度裁剪后训练稳定')
  assert.equal(draft.category, 'method')
  assert.equal(draft.ktype, 'method')
  assert.equal(draft.rec_approach, lessonRecord().body)
  assert.deepEqual(draft.forbid, [])
  assert.equal(draft.source_event, 'dsh-neural-workflow experience exp-0a1b2c3d4e5f')
  assert.equal(draft.status, 'draft')
  // 纯函数单独调用时回退到记录自带的 createdAt。
  assert.equal(draft.created_at, '2026-01-01T00:00:00.000Z')
  // 同一条经验永远折出同一个 id。
  assert.equal(draft.draftId, draftFromExperience(lessonRecord()).draftId)
})

test('draftFromExperience：negative 带 forbid，idea 映射 idea，error_signature 抽 body 关键句', () => {
  const negative = draftFromExperience(
    lessonRecord({ id: 'exp-000000000001', kind: 'negative', title: '降低学习率救不了标签错位' }),
  )
  assert.equal(negative.category, 'error')
  assert.equal(negative.ktype, 'error')
  assert.deepEqual(negative.forbid, ['降低学习率救不了标签错位'])

  const idea = draftFromExperience(lessonRecord({ id: 'exp-000000000002', kind: 'idea' }))
  assert.equal(idea.category, 'idea')
  assert.deepEqual(idea.forbid, [])

  // 关键句按句读切分、去空、有界，保留原句不改写。
  assert.deepEqual(draftFromExperience(lessonRecord()).error_signature, [
    '先裁剪梯度再检查学习率',
    '学习率过大会复现 loss 膨胀',
  ])
  assert.deepEqual(draftFromExperience(lessonRecord({ body: '' })).error_signature, [])
})

test('draftFromExperience：坏输入直接抛错，不静默折出空草稿', () => {
  assert.throws(() => draftFromExperience(null), TypeError)
  assert.throws(() => draftFromExperience({ title: 'x', body: 'y', kind: 'lesson' }), /id/)
  assert.throws(() => draftFromExperience(lessonRecord({ title: '  ' })), /title/)
  assert.throws(() => draftFromExperience(lessonRecord({ kind: 'hypothesis' })), RangeError)
  assert.throws(() => draftFromExperience(lessonRecord({ body: 42 })), TypeError)
})

test('writeDraft：写入 <draftsDir>/<draftId>.json，created_at 来自注入时钟', (t) => {
  const { draftsDir, backflow } = makeBackflow(t)
  const { draft, skipped } = backflow.writeDraft(lessonRecord())

  assert.equal(skipped, false)
  const file = path.join(draftsDir, `${draft.draftId}.json`)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.draftId, draft.draftId)
  assert.equal(onDisk.created_at, '2026-01-01T00:00:00.000Z')
  // 目录不存在时也能第一次写入。
  assert.ok(fs.existsSync(draftsDir))
})

test('writeDraft：重复写内容一致时跳过（幂等），不一致时报错', (t) => {
  const { draftsDir, backflow } = makeBackflow(t)
  const first = backflow.writeDraft(lessonRecord())

  // 同一条经验再回流一次：落同一个文件，不产生第二份。
  const again = backflow.writeDraft(lessonRecord())
  assert.equal(again.skipped, true)
  assert.equal(fs.readdirSync(draftsDir).length, 1)

  // 同 id 但正文被改过：冲突必须抛错，不能悄悄覆盖。
  const mutated = lessonRecord({ body: '正文被人改过了' })
  assert.throws(() => backflow.writeDraft(mutated), /冲突/)
  assert.equal(fs.readdirSync(draftsDir).length, 1)
  assert.ok(first.draft.draftId)
})

test('readDraft / listDrafts：读回完整草稿，清单只认草稿文件', (t) => {
  const { draftsDir, backflow } = makeBackflow(t)
  const { draft } = backflow.writeDraft(lessonRecord())
  backflow.writeDraft(lessonRecord({ id: 'exp-ffffffffffff', title: '另一条经验' }))

  assert.deepEqual(backflow.readDraft(draft.draftId), JSON.parse(fs.readFileSync(path.join(draftsDir, `${draft.draftId}.json`), 'utf8')))
  assert.throws(() => backflow.readDraft('DRAFT-00000000'), /未知草稿 id/)

  const listed = backflow.listDrafts()
  assert.equal(listed.length, 2)
  assert.deepEqual(
    listed.map((item) => item.status),
    ['draft', 'draft'],
  )
  // 非草稿命名的文件不进清单。
  fs.writeFileSync(path.join(draftsDir, 'README.md'), 'not a draft', 'utf8')
  fs.writeFileSync(path.join(draftsDir, 'DRAFT-broken.json'), '{oops', 'utf8')
  assert.equal(backflow.listDrafts().length, 2)
  // 草稿区还没建时清单为空，不抛。
  assert.deepEqual(new Backflow({ draftsDir: path.join(draftsDir, 'missing'), graphDir: draftsDir }).listDrafts(), [])
})

test('promote：无 explicit 拒绝，npId 格式非法拒绝', (t) => {
  const { graphDir, backflow } = makeBackflow(t)
  const { draft } = backflow.writeDraft(lessonRecord())

  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP601'), /explicit: true/)
  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP601', { explicit: false }), /explicit: true/)
  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP601', { explicit: 'yes' }), /explicit: true/)

  assert.throws(() => backflow.promoteDraft(draft.draftId, 'np601', { explicit: true }), RangeError)
  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP601X', { explicit: true }), RangeError)
  assert.throws(() => backflow.promoteDraft(draft.draftId, '../evil', { explicit: true }), RangeError)
  // 被拒绝的调用一个文件都不该写。
  assert.equal(fs.existsSync(graphDir), false)
})

test('promote：explicit 后写入 graphDir/<npId>.json，草稿标记 status:promoted', (t) => {
  const { draftsDir, graphDir, backflow } = makeBackflow(t)
  const { draft } = backflow.writeDraft(lessonRecord())

  const result = backflow.promoteDraft(draft.draftId, 'NP601', { explicit: true })
  assert.equal(result.npId, 'NP601')

  const promoted = JSON.parse(fs.readFileSync(path.join(graphDir, 'NP601.json'), 'utf8'))
  assert.equal(promoted.draftId, draft.draftId)
  assert.equal(promoted.title, '梯度裁剪后训练稳定')
  assert.equal(promoted.source_event, 'dsh-neural-workflow experience exp-0a1b2c3d4e5f')

  const marked = JSON.parse(fs.readFileSync(path.join(draftsDir, `${draft.draftId}.json`), 'utf8'))
  assert.equal(marked.status, 'promoted')

  // 已经 promote 过的草稿不能二次升格（status 不再是 draft）。
  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP602', { explicit: true }), /status/)
  assert.equal(fs.existsSync(path.join(graphDir, 'NP602.json')), false)
})

test('promote：NP 已存在拒绝覆盖，未知草稿 id 抛错', (t) => {
  const { graphDir, backflow } = makeBackflow(t)
  const { draft } = backflow.writeDraft(lessonRecord())
  fs.mkdirSync(graphDir, { recursive: true })
  const existing = path.join(graphDir, 'NP001.json')
  fs.writeFileSync(existing, '{"id":"NP001"}', 'utf8')

  assert.throws(() => backflow.promoteDraft(draft.draftId, 'NP001', { explicit: true }), /NP 冲突/)
  // 正式条目一个字节都没被动过。
  assert.equal(fs.readFileSync(existing, 'utf8'), '{"id":"NP001"}')
  // 草稿也保持原样（promote 是先读后写，冲突发生在写图谱之前）。
  assert.equal(backflow.readDraft(draft.draftId).status, 'draft')

  assert.throws(() => backflow.promoteDraft('DRAFT-00000000', 'NP602', { explicit: true }), /未知草稿 id/)
  assert.throws(() => new Backflow({ draftsDir: '', graphDir: 'x' }), TypeError)
})
