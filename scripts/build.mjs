#!/usr/bin/env node
/**
 * 构建脚本：把数据与原生产物搬进可发布的 `lib/`，然后自检。
 *
 * 为什么要有这一步：DSH 插件发行物里的主入口是 `.js`，运行期不该读 `graph/*.json`
 * （发行物未必带、CWD 也不保证）。所以数据在**构建期**折成模块，
 * 原生二进制在**构建期**从 `native/target/release/` 复制到 `lib/native/`。
 *
 * 用法：
 *   node scripts/build.mjs           # 数据折叠 + 复制二进制（有就复制）
 *   node scripts/build.mjs --check   # 只校验，不写
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

/** 数据 → 模块。输出稳定（同一份 JSON 生成同一份文件），便于 git diff 审阅。 */
function emitGraphData() {
  const graph = readJson('graph/neural-paper-workflow.json')
  const body = `/** 生成文件：由 scripts/build.mjs 从 graph/neural-paper-workflow.json 生成，勿手改。 */
export const GRAPH_DATA = ${JSON.stringify(graph, null, 2)}
`
  const target = join(root, 'lib/graph-data.js')
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (current !== body) {
      console.error('lib/graph-data.js 与 graph/neural-paper-workflow.json 不一致；请运行 node scripts/build.mjs')
      return false
    }
    return true
  }
  writeFileSync(target, body, 'utf8')
  return true
}

function copyNative() {
  const binary = process.platform === 'win32' ? 'nw-constrain.exe' : 'nw-constrain'
  const source = join(root, 'native', 'target', 'release', binary)
  const target = join(root, 'lib', 'native', binary)
  if (!existsSync(source)) {
    console.warn(`build: 跳过原生复制（未找到 native/target/release/${binary}）——先跑 native/build.sh`)
    return
  }
  if (check) {
    if (!existsSync(target)) {
      console.error(`build: lib/native/${binary} 缺失；请运行 node scripts/build.mjs`)
      return
    }
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  // 宿主正在跑时那个二进制是被占用的（EBUSY/LOCK）——这不是失败：
  // 目标已经是同一份构建，或者稍后重启宿主就会用上新的。报告清楚即可。
  try {
    copyFileSync(source, target)
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.warn(`build: lib/native/${binary} 被占用（宿主可能正在使用）；保留现有二进制，重启宿主后重新构建即可`)
      return
    }
    throw error
  }
}

/** 图的完整性：每条边端点都在节点表里，层 id 都声明过。 */
function verifyGraph() {
  const graph = readJson('graph/neural-paper-workflow.json')
  const nodes = new Set((graph.nodes ?? []).map((node) => node.id))
  const layers = new Set((graph.layers ?? []).map((layer) => layer.id))
  const problems = []
  for (const node of graph.nodes ?? []) {
    if (!layers.has(node.layer)) problems.push(`节点 ${node.id} 的层 ${node.layer} 未声明`)
    if ((node.evidenceKinds ?? []).length === 0) problems.push(`节点 ${node.id} 没有证据种类`)
  }
  for (const edge of graph.edges ?? []) {
    if (!nodes.has(edge.from)) problems.push(`边起点 ${edge.from} 不存在`)
    if (!nodes.has(edge.to)) problems.push(`边终点 ${edge.to} 不存在`)
  }
  return problems
}

const problems = verifyGraph()
if (problems.length > 0) {
  for (const problem of problems) console.error(`build: 图不合法 — ${problem}`)
  process.exit(1)
}
const consistent = emitGraphData()
copyNative()
if (!consistent) process.exit(1)
console.log(`build: ${check ? '校验通过' : '完成'}（${(readJson('graph/neural-paper-workflow.json').nodes ?? []).length} 个节点）`)
