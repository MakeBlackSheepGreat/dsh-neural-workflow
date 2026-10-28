#!/usr/bin/env node
/**
 * 契约基线：把"会被别人依赖的形状"抽成机器可比的快照，跨版本检测漂移。
 *
 * 为什么需要：`PROTOCOL.md` 是散文，改一个 op 名或删一个证据字段，
 * 读文档的人不会知道，已经对接的一方会静默坏掉。这里把四类契约折成 JSON：
 *
 *   1. graph      —— 节点/层的 id 与每个节点的 evidenceKinds（数据契约）
 *   2. protocol   —— 中间件的 op 名与错误码（线协议契约，源码抽取）
 *   3. evidence   —— 证据记录字段（fold 契约）
 *   4. vocabulary —— 被接受的证据种类并集（词表契约）
 *
 * 用法：
 *   node scripts/check-release.mjs --snapshot   # 写入 docs/schema-baseline.json
 *   node scripts/check-release.mjs --check      # 漂移则非零退出并列出差异
 *
 * 纪律：`--check` 只报差异，不自动改基线。要不要接受漂移是人的决定。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(root, 'docs', 'schema-baseline.json')

const snapshot = process.argv.includes('--snapshot')
const check = process.argv.includes('--check')
if (!snapshot && !check) {
  console.error('用法：node scripts/check-release.mjs --snapshot | --check')
  process.exit(2)
}

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

function readText(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

/** 1. 图：层与节点（含 evidenceKinds），边按 from→to 排序。 */
function graphShape() {
  const graph = readJson('graph/neural-paper-workflow.json')
  return {
    layers: (graph.layers ?? []).map((layer) => layer.id).sort(),
    nodes: Object.fromEntries(
      (graph.nodes ?? [])
        .map((node) => [node.id, { layer: node.layer, kinds: [...(node.evidenceKinds ?? [])].sort() }])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    edges: (graph.edges ?? []).map((edge) => `${edge.from}->${edge.to}`).sort(),
  }
}

/** 2. 线协议：从 Rust 源码抽取 op 名与错误码，不靠文档抄。 */
function protocolShape() {
  const source = readText('native/src/main.rs')
  const ops = [...source.matchAll(/^\s*"([a-z_]+)" =>/gm)].map((match) => match[1])
  const errorCodes = [...new Set([...source.matchAll(/"E_[A-Z_]+"/g)].map((match) => match[0].replaceAll('"', '')))]
  const constraints = [...new Set([...source.matchAll(/const CODE_[A-Z_]+: &str = "([A-Z0-9]+)"/g)].map((match) => match[1]))]
  return {
    ops: [...new Set(ops)].sort(),
    errorCodes: errorCodes.sort(),
    constraints: constraints.sort(),
  }
}

/** 3. 证据记录字段：从折账实现取值处抽取（`evidence.<field>`）。 */
function evidenceShape() {
  const source = readText('lib/fold.js')
  const fields = new Set()
  for (const match of source.matchAll(/evidence\.([a-zA-Z]+)/g)) fields.add(match[1])
  // 顶层自有字段（不在 evidence 子对象里）
  for (const field of ['id', 'node', 'kind', 'at', 'note', 'anchors', 'seq']) {
    if (source.includes(`    ${field}:`)) fields.add(field)
  }
  return { fields: [...fields].sort() }
}

/** 4. 词表：被接受的种类并集 + 特殊种类。 */
function vocabularyShape() {
  const source = readText('lib/vocab.js')
  const failure = /FAILURE_KIND = '([a-z]+)'/.exec(source)?.[1]
  const graph = readJson('graph/neural-paper-workflow.json')
  const kinds = [...new Set((graph.nodes ?? []).flatMap((node) => node.evidenceKinds ?? []))].sort()
  return { kinds, auditKind: failure ?? null }
}

const current = {
  graph: graphShape(),
  protocol: protocolShape(),
  evidence: evidenceShape(),
  vocabulary: vocabularyShape(),
}

if (snapshot) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  const counts = {
    nodes: Object.keys(current.graph.nodes).length,
    ops: current.protocol.ops.length,
    errorCodes: current.protocol.errorCodes.length,
    constraints: current.protocol.constraints.length,
    fields: current.evidence.fields.length,
    kinds: current.vocabulary.kinds.length,
  }
  console.log(`baseline: 已写入 docs/schema-baseline.json（${JSON.stringify(counts)}）`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error('baseline: 缺少 docs/schema-baseline.json；先跑 --snapshot')
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const differences = []

/** 递归比较，只报"新增/删除/值变化"，路径可读。 */
function compare(path, before, after) {
  if (Array.isArray(before) && Array.isArray(after)) {
    const added = after.filter((item) => !before.includes(item))
    const removed = before.filter((item) => !after.includes(item))
    for (const item of added) differences.push(`+ ${path}[] ${JSON.stringify(item)}`)
    for (const item of removed) differences.push(`- ${path}[] ${JSON.stringify(item)}`)
    // 顺序变化也算漂移：数组是排序过的，顺序变了说明来源变了。
    if (added.length === 0 && removed.length === 0 && before.join('\u0000') !== after.join('\u0000')) {
      differences.push(`~ ${path}[] 顺序变化`)
    }
    return
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in before)) differences.push(`+ ${path}.${key}`)
      else if (!(key in after)) differences.push(`- ${path}.${key}`)
      else compare(`${path}.${key}`, before[key], after[key])
    }
    return
  }
  if (before !== after) differences.push(`~ ${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
}

compare('contract', baseline, current)

if (differences.length > 0) {
  console.error(`baseline: 契约漂移 ${differences.length} 处（若要接受，跑 --snapshot 并说明原因）：`)
  for (const line of differences) console.error(`  ${line}`)
  process.exit(1)
}
console.log('baseline: 契约未漂移')
