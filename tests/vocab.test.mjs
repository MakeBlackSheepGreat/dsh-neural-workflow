#!/usr/bin/env node
/** 词表校验测试：把"字母打错静默不匹配"钉成可回归的行为。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FAILURE_KIND, kindsFor, validateEvidence, vocabulary } from '../lib/vocab.js'
import { GRAPH_DOC } from '../lib/graph.js'

test('合法节点与种类通过', () => {
  const node = GRAPH_DOC.nodes[0]
  assert.equal(validateEvidence(node.id, node.evidenceKinds[0]).ok, true)
})

test('未知节点被拒并给出候选', () => {
  const verdict = validateEvidence('scop', 'test')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'UNKNOWN_NODE')
  assert.ok(verdict.candidates.includes('scope'), `候选应含 scope，实际 ${JSON.stringify(verdict.candidates)}`)
})

test('种类打错被拒并给出候选', () => {
  const verdict = validateEvidence('scope', 'hypothesys')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'UNKNOWN_KIND')
  assert.ok(verdict.candidates.includes('hypothesis'))
})

test('空值被拒', () => {
  assert.equal(validateEvidence('', 'test').code, 'UNKNOWN_NODE')
  assert.equal(validateEvidence('scope', '').code, 'UNKNOWN_KIND')
})

test('failure 是审计事实：任何节点都接受', () => {
  for (const node of GRAPH_DOC.nodes) {
    const verdict = validateEvidence(node.id, FAILURE_KIND)
    assert.equal(verdict.ok, true, `${node.id} 应接受 failure`)
    assert.equal(verdict.audit, true)
  }
})

test('kindsFor 与图一致', () => {
  for (const node of GRAPH_DOC.nodes) {
    assert.deepEqual(kindsFor(node.id), node.evidenceKinds ?? [])
  }
})

test('词表快照覆盖所有节点', () => {
  const snapshot = vocabulary()
  assert.equal(snapshot.nodes.length, GRAPH_DOC.nodes.length)
  assert.equal(snapshot.failureKind, FAILURE_KIND)
  assert.ok(snapshot.kinds.length > 0)
})
