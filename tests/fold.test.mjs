#!/usr/bin/env node
/**
 * fold 与 brief 的纯函数测试。
 *
 * 这两块是**唯一的**状态解释与文字渲染路径：投影、工具、面板、提示词都读它们。
 * 所以它们的确定性（同一份日志折两遍必须逐字节一致）是硬要求，不是风格偏好。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEvent, emptyState, evidenceOf, foldEvents, timelineOf, detailOf } from '../lib/fold.js'
import { brief, renderBrief } from '../lib/brief.js'

/** 造一条工具结果事件；`payload` 就是 neural_flow 返回的 JSON 对象。 */
function toolResult(payload, seq = 1, time = 1_700_000_000_000) {
  return {
    type: 'tool/result',
    seq,
    time,
    data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: JSON.stringify(payload) }] } },
  }
}

const accepted = {
  recorded: true,
  ok: true,
  evidence: { id: 'ev-1', node: 'scope', kind: 'hypothesis', at: '2026-01-01T00:00:00Z', note: 'H1', anchors: [{ path: 'notes/h.md' }] },
}

test('只认带 recorded:true 的工具结果', () => {
  assert.notEqual(evidenceOf(toolResult(accepted)), null)
  // 被拒的记录（没有 recorded:true）不入账——账本不能被"差点发生"的事实污染。
  assert.equal(evidenceOf(toolResult({ ok: false, reason: 'constraint_violation' })), null)
  assert.equal(evidenceOf(toolResult({ recorded: true })), null)
  assert.equal(evidenceOf({ type: 'tool/result', seq: 1, time: 0, data: { message: { content: [] } } }), null)
  assert.equal(evidenceOf({ type: 'user/message', seq: 1, time: 0, data: {} }), null)
  assert.equal(evidenceOf(null), null)
})

test('非 JSON 的工具结果不炸', () => {
  const event = { type: 'tool/result', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: 'plain output' }] } } }
  assert.equal(evidenceOf(event), null)
})

test('证据必须带 id / node / kind', () => {
  assert.equal(evidenceOf(toolResult({ recorded: true, evidence: { node: 'scope', kind: 'x' } })), null)
  assert.equal(evidenceOf(toolResult({ recorded: true, evidence: { id: 'e', kind: 'x' } })), null)
  assert.equal(evidenceOf(toolResult({ recorded: true, evidence: { id: 'e', node: 'scope' } })), null)
})

test('同一份日志折两遍逐字节一致', () => {
  const events = [
    toolResult(accepted, 1),
    toolResult({ ...accepted, evidence: { ...accepted.evidence, id: 'ev-2', node: 'develop', kind: 'test' } }, 2),
  ]
  const first = foldEvents(events)
  const second = foldEvents(events)
  assert.deepEqual(first.ledger, second.ledger)
  assert.deepEqual(timelineOf(first), timelineOf(second))
  assert.deepEqual(detailOf(first), detailOf(second))
})

test('重复 id 只入账一次（后者丢弃）', () => {
  const state = foldEvents([toolResult(accepted, 1), toolResult({ ...accepted, evidence: { ...accepted.evidence, note: '重复' } }, 2)])
  assert.equal(state.ledger.length, 1)
  assert.equal(state.ledger[0].note, 'H1')
})

test('证据顺序按日志顺序，与事件 seq 一致', () => {
  const state = foldEvents([
    toolResult({ recorded: true, evidence: { id: 'a', node: 'scope', kind: 'note' } }, 5),
    toolResult({ recorded: true, evidence: { id: 'b', node: 'scope', kind: 'note' } }, 9),
  ])
  assert.deepEqual(state.ledger.map((item) => item.id), ['a', 'b'])
  assert.equal(state.seq, 9)
})

test('账本有上限：超出从头部挤出，seen 同步收缩', () => {
  let state = emptyState()
  for (let index = 0; index < 410; index += 1) {
    state = applyEvent(state, toolResult({ recorded: true, evidence: { id: `ev-${index}`, node: 'scope', kind: 'note' } }, index + 1))
  }
  assert.equal(state.ledger.length, 400)
  assert.equal(Object.hasOwn(state.seen, 'ev-0'), false)
  assert.equal(Object.hasOwn(state.seen, 'ev-409'), true)
})

test('timeline 只带近期窗口，detail 带全量', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    toolResult({ recorded: true, evidence: { id: `ev-${index}`, node: 'scope', kind: 'note', at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z` } }, index + 1),
  )
  const state = foldEvents(many)
  const timeline = timelineOf(state)
  assert.equal(timeline.total, 30)
  assert.equal(timeline.recent.length, 24)
  assert.equal(timeline.recent.at(-1).id, 'ev-29')
  assert.equal(detailOf(state).ledger.length, 30)
})

test('brief：空判定不产出文字', () => {
  assert.equal(renderBrief(null), '')
  assert.equal(renderBrief({}), '')
  assert.equal(brief(null), null)
})

test('brief：前沿与违规都进文字，且面板字段同源', () => {
  const verdict = {
    progress: { satisfied: 2, total: 10 },
    frontier: ['train'],
    layers: [{ id: 'L1', satisfied: 0, total: 3 }],
    nodes: { a: { state: 'satisfied' }, b: { state: 'ready' }, c: { state: 'blocked' } },
    violations: [{ constraint: 'C3', message: '越序' }],
  }
  const text = renderBrief(verdict)
  assert.match(text, /2\/10/)
  assert.match(text, /train/)
  assert.match(text, /C3/)
  const summary = brief(verdict)
  assert.deepEqual(summary.counts, { satisfied: 1, ready: 1, blocked: 1 })
  assert.equal(summary.text, text)
})

test('brief：违规超过 6 条时折叠', () => {
  const verdict = { violations: Array.from({ length: 9 }, (_, index) => ({ constraint: 'C1', message: `m${index}` })) }
  assert.match(renderBrief(verdict), /另有 3 条/)
})
