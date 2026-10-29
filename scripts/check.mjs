#!/usr/bin/env node
/**
 * 静态自检：装进 profile 之前先证明"能加载、形状对、不踩已知的地雷"。
 *
 * 检查项（任何一项失败即退出 1）：
 *   1. 每个 JS 文件能通过 `node --check` 等价的语法解析（用 `new Function` 不行——
 *      ESM 有 import；这里用 `vm.SourceTextModule` 不可靠，直接调 `node --check`）。
 *   2. 客户端 bundle 是 `window.__ModuleLoader__.load({id, factory})` 形状。
 *   3. 客户端注册的 slot id/name 在实时 catalogue 里存在（避免"注册了但永不显示"）。
 *   4. 包 JSON 的 dsh.bundle.patch / dsh.client 指向真实文件。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}

function syntaxCheck(relative) {
  const absolute = join(root, relative)
  if (!existsSync(absolute)) {
    fail(`缺少文件 ${relative}`)
    return
  }
  try {
    execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' })
  } catch (error) {
    fail(`语法错误 ${relative}: ${String(error.stderr ?? error.message).split('\n').slice(0, 4).join(' ')}`)
  }
}

// ── 1. 语法 ────────────────────────────────────────────────────────────────
for (const relative of ['lib/index.js', 'lib/fold.js', 'lib/graph.js', 'lib/graph-data.js', 'lib/brief.js', 'lib/constraints.js', 'lib/client.js', 'lib/figure.js', 'lib/retrieval.js', 'lib/kb-graph.js']) {
  syntaxCheck(relative)
}

// ── 2. 客户端 bundle 形状 ─────────────────────────────────────────────────
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
if (!client.includes('__ModuleLoader__.load')) fail('lib/client.js 不是 __ModuleLoader__ bundle')
if (!client.includes("id: 'dsh-neural-workflow'")) fail('lib/client.js 的 bundle id 与包名不一致')

// 客户端模块名必须与宿主的 name 一致，否则 locale 绑定会找不到字典。
const hostEntry = readFileSync(join(root, 'lib/index.js'), 'utf8')
if (!/export const name = 'neural-workflow'/.test(hostEntry)) fail("lib/index.js 的 name 必须是 'neural-workflow'")

// ── 3. slot 名字：只允许 inspect 里真实存在的那几个 ────────────────────────
// 左侧三处由 ctx 直接注册；右侧栏两处由 ctx.inject(['sidebarRightTabs']) 的
// scoped ctx 注册（服务缺席时整体跳过），所以分开统计。
const KNOWN_SLOTS = new Set(['sidebar.panellist', 'main', 'conversation.view'])
const KNOWN_RIGHT_SLOTS = new Set(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
for (const slot of [...KNOWN_SLOTS, ...KNOWN_RIGHT_SLOTS]) {
  if (!client.includes(`'${slot}'`)) notes.push(`客户端未注册 ${slot}`)
}
const declared = [...client.matchAll(/ctx\.slots\.inject\('([^']+)'/g)].map((match) => match[1])
for (const slot of declared) {
  if (!KNOWN_SLOTS.has(slot)) fail(`客户端注入了未知 slot: ${slot}`)
}
if (declared.length !== KNOWN_SLOTS.size) {
  fail(`客户端 slot 注入数量 ${declared.length}，预期 ${KNOWN_SLOTS.size}`)
}
const declaredRight = [...client.matchAll(/scoped\.slots\.inject\('([^']+)'/g)].map((match) => match[1])
for (const slot of declaredRight) {
  if (!KNOWN_RIGHT_SLOTS.has(slot)) fail(`客户端注入了未知右侧栏 slot: ${slot}`)
}
if (declaredRight.length !== KNOWN_RIGHT_SLOTS.size) {
  fail(`右侧栏 slot 注入数量 ${declaredRight.length}，预期 ${KNOWN_RIGHT_SLOTS.size}`)
}
// 右侧栏 tab 类型必须先于两个 slot 声明：没有类型就没有 key 被派发，body 永不渲染。
if (!/sidebarRightTabs/.test(client)) fail('客户端没有声明右侧栏 tab 类型（sidebarRightTabs）')

// ── 4. manifest ───────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.main !== 'lib/index.js') fail('package.json main 应为 lib/index.js')
if (!existsSync(join(root, 'cordis.patch.yml'))) fail('缺少 cordis.patch.yml')
if (pkg?.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json dsh.bundle.patch 指向错误')
// 两份 manifest 的版本必须一致：profile 用 file:/link 依赖时按版本号判断是否重装，
// 版本号落后会让"改了却没生效"这种问题看起来像代码 bug。
const manifest = JSON.parse(readFileSync(join(root, 'dsh-plugin.json'), 'utf8'))
if (manifest.version !== pkg.version) {
  fail(`dsh-plugin.json 版本 ${manifest.version} 与 package.json 版本 ${pkg.version} 不一致`)
}
for (const key of ['lib', 'locale', 'icon.svg']) {
  if (!(pkg.files ?? []).includes(key)) fail(`package.json files 缺少 ${key}`)
}
for (const file of readdirSync(join(root, 'locale'))) {
  JSON.parse(readFileSync(join(root, 'locale', file), 'utf8'))
}

// ── 5. 图与中间件契约对齐（数据侧，不做判定） ─────────────────────────────
const graph = JSON.parse(readFileSync(join(root, 'graph/neural-paper-workflow.json'), 'utf8'))
const nodeIds = new Set(graph.nodes.map((node) => node.id))
for (const edge of graph.edges) {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail(`图里存在悬空边 ${edge.from} → ${edge.to}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check: ${problem}`)
  process.exit(1)
}
for (const note of notes) console.warn(`check: ${note}`)
console.log(`check: 通过（${nodeIds.size} 个节点，${graph.edges.length} 条边，${declared.length} 个 slot）`)
