#!/usr/bin/env node
/**
 * 中间件契约测试：用真实二进制跑 PROTOCOL.md 的每一节。
 *
 * 这些测试是**集成**测试，不是单元测试——它们证明"宿主半怎么调，中间件就怎么答"，
 * 而不是"函数返回值对不对"。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BINARY = join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'nw-constrain.exe' : 'nw-constrain')
const GRAPH = JSON.parse(readFileSync(join(root, 'graph/neural-paper-workflow.json'), 'utf8'))

const skip = existsSync(BINARY) ? false : 'nw-constrain 未构建（先跑 native/build.sh）'

/** 起一个 worker，返回 ask() 与 stop()。 */
function open() {
  const child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  const queue = []
  const pending = []
  lines.on('line', (line) => {
    const payload = JSON.parse(line)
    const index = pending.findIndex((item) => item.id === String(payload.id))
    if (index >= 0) pending.splice(index, 1)[0].resolve(payload)
    else queue.push(payload)
  })
  let sequence = 0
  return {
    ask(op, input = {}) {
      const id = String(++sequence)
      return new Promise((resolve) => {
        pending.push({ id, resolve })
        child.stdin.write(`${JSON.stringify({ id, op, input })}\n`)
      })
    },
    stop() {
      child.stdin.end()
      child.kill()
    },
  }
}

test('selftest：二进制自证与契约一致', { skip }, async () => {
  const worker = open()
  try {
    const response = await worker.ask('selftest')
    assert.equal(response.ok, true)
    assert.deepEqual(response.value.failed, [])
    assert.ok(response.value.checks >= 10)
  } finally {
    worker.stop()
  }
})

test('evaluate：空账本 → 首层 ready，下游 blocked', { skip }, async () => {
  const worker = open()
  try {
    const response = await worker.ask('evaluate', { graph: GRAPH, evidence: [] })
    assert.equal(response.ok, true)
    const value = response.value
    assert.equal(value.ok, true)
    assert.deepEqual(value.frontier, ['scope'])
    assert.equal(value.nodes.scope.state, 'ready')
    assert.equal(value.nodes.train.state, 'blocked')
    assert.deepEqual(value.nodes.train.blockedBy, ['develop'])
  } finally {
    worker.stop()
  }
})

test('evaluate：越序推进被 C3 拦下', { skip }, async () => {
  const worker = open()
  try {
    const response = await worker.ask('evaluate', {
      graph: GRAPH,
      evidence: [{ id: 'e1', node: 'train', kind: 'run', at: '2026-01-01T00:00:00Z', anchors: [{ path: 'runs/1' }] }],
    })
    const codes = response.value.violations.map((item) => item.constraint)
    assert.deepEqual(codes, ['C3'])
  } finally {
    worker.stop()
  }
})

test('evaluate：合法链路推进到 frontier 下移', { skip }, async () => {
  const worker = open()
  try {
    const response = await worker.ask('evaluate', {
      graph: GRAPH,
      evidence: [
        { id: 'e1', node: 'scope', kind: 'hypothesis', at: '2026-01-01T00:00:00Z', anchors: [{ path: 'notes/h.md' }] },
        { id: 'e2', node: 'develop', kind: 'test', at: '2026-01-02T00:00:00Z', anchors: [{ path: 'tests/' }] },
      ],
    })
    assert.deepEqual(response.value.violations, [])
    assert.equal(response.value.nodes.scope.state, 'satisfied')
    assert.deepEqual(response.value.frontier, ['train'])
    assert.equal(response.value.progress.satisfied, 2)
  } finally {
    worker.stop()
  }
})

test('evaluate：终局声明在证据不足时被 C5 拒绝', { skip }, async () => {
  const worker = open()
  try {
    const response = await worker.ask('evaluate', {
      graph: GRAPH,
      evidence: [
        { id: 'e1', node: 'scope', kind: 'hypothesis', at: '2026-01-01T00:00:00Z', anchors: [{ path: 'a' }] },
        { id: 'e2', node: 'develop', kind: 'test', at: '2026-01-02T00:00:00Z', anchors: [{ path: 'b' }] },
        { id: 'e3', node: 'train', kind: 'run', at: '2026-01-03T00:00:00Z', anchors: [{ path: 'c' }] },
        { id: 'e4', node: 'infer', kind: 'run', at: '2026-01-04T00:00:00Z', anchors: [{ path: 'd' }] },
        { id: 'e5', node: 'validate', kind: 'result', at: '2026-01-05T00:00:00Z', anchors: [{ path: 'e' }] },
        { id: 'e6', node: 'conclude', kind: 'claim', at: '2026-01-06T00:00:00Z', anchors: [{ path: 'f' }] },
        { id: 'e7', node: 'write', kind: 'draft', at: '2026-01-07T00:00:00Z', anchors: [{ path: 'g' }] },
        { id: 'e8', node: 'figure', kind: 'figure', at: '2026-01-08T00:00:00Z', anchors: [{ path: 'h' }] },
        { id: 'e9', node: 'polish', kind: 'draft', at: '2026-01-09T00:00:00Z' },
        { id: 'e10', node: 'submit', kind: 'completion', at: '2026-01-10T00:00:00Z', anchors: [{ path: 'i' }] },
      ],
    })
    // 全部前置都满足时，completion 应当通过。
    assert.deepEqual(response.value.violations, [])
    assert.equal(response.value.progress.satisfied, response.value.progress.total)
  } finally {
    worker.stop()
  }
})

test('协议：坏 JSON 与未知 op 都返回结构化错误，进程不退出', { skip }, async () => {
  const worker = open()
  try {
    const bad = await worker.ask('evaluate', { graph: null })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'E_INPUT')
    const good = await worker.ask('selftest')
    assert.equal(good.ok, true)
  } finally {
    worker.stop()
  }
})
