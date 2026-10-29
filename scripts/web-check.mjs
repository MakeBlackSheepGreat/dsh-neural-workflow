#!/usr/bin/env node
/**
 * 蛛网图的专用视觉检查：在**宽容器**里渲染，单独截图。
 *
 * 为什么单独做：蛛网需要整行宽度，而主面板截图里它被塞在 320px 的右栏里，
 * 看不出真实形态。这个脚本只渲染蛛网本身，宽度可调，用来确认
 * "扇区结构可见、点不重叠、连线不过密"。
 *
 * 用法：node scripts/web-check.mjs [输出目录]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { graph as kbGraph } from '../lib/kb-graph.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ?? join(root, '.visual')
mkdirSync(outDir, { recursive: true })

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

let factory
globalThis.window = { __ModuleLoader__: { load(definition) { factory = definition.factory } } }
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {},
  useMemo: (make) => make(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  Fragment: 'Fragment',
}
new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)
const internals = factory((id) => (id === 'react' ? reactStub : { jsx: reactStub.createElement, jsxs: reactStub.createElement })).__test__

const cssStart = source.indexOf('const CSS = `') + 'const CSS = `'.length
const css = source.slice(cssStart, source.indexOf('`\n\n    /**', cssStart))

const DICT = {
  web: '蛛网', search: '检索', entries: '条', links: '条连接', fit: '适应',
  category: {
    idea: '想法', error: '错误', experiment: '实验', perf: '性能', writing: '写作',
    statistics: '统计', leakage: '泄漏', compliance: '合规', method: '方法',
    process: '流程', citation: '引用', figure: '图稿', other: '其它',
  },
}
const t = (key) => {
  if (key.startsWith('category.')) {
    const id = key.slice('category.'.length)
    return DICT.category[id] ?? key
  }
  return DICT[key] ?? key
}

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object' || !('type' in node)) return ''
  const { type, props, children } = node
  if (typeof type === 'function') return render(type(props))
  const attrs = Object.entries(props ?? {})
    .filter(([key]) => key !== 'children' && key !== 'key' && key !== 'ref')
    .map(([key, value]) => {
      const name = key === 'className' ? 'class' : key
      if (name === 'style' && value !== null && typeof value === 'object') {
        const body = Object.entries(value).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`).join(';')
        return ` style="${esc(body)}"`
      }
      if (value === null || value === undefined || value === false) return ''
      if (typeof value === 'function' || typeof value === 'object') return ''
      return ` ${name}="${esc(value)}"`
    })
    .join('')
  return `<${type}${attrs}>${render(children)}</${type}>`
}

const chrome = [
  'C:/Users/876762330/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  'C:/Users/876762330/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
].find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  console.error('web-check: 找不到无头 Chrome')
  process.exit(1)
}

const TOKENS = `:root{--dsw-alias-label-primary:#1a1a1a;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#999;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#f2f2f2;--dsw-alias-border-l1:#ececec;--dsw-alias-border-l2:#dcdcdc;--dsw-alias-brand-primary:#3b6cf0;--dsw-alias-state-success-primary:#1a9c5b;--dsw-alias-state-error-primary:#d92d48;--dsw-alias-state-warn-primary:#b7791f}
body{margin:0;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#fff}`

const problems = []
const graphData = kbGraph()
const layout = internals.webLayout(graphData)

// 布局的硬断言：这些是"图能不能看"的前提，不看截图也能判。
//
// 注意默认是**过滤**视图（只画度数 ≥5 的枢纽），所以点数少于总数是设计，
// 不是缺陷。要断言的是：可见的点都画出来了、隐藏数被如实报出来。
if (layout.hidden !== graphData.entries.length - layout.entries.length) {
  problems.push(`hidden 计数不对：${layout.hidden} vs 实际 ${graphData.entries.length - layout.entries.length}`)
}
if (layout.entries.length === 0) problems.push('一个点都没画出来')
if (layout.edges.length === 0) problems.push('一条边都没连出来')
// 全部展开时应当把 611 条都放进去。
const all = new Set(graphData.categories.map((category) => category.id))
const fullLayout = internals.webLayout(graphData, { expanded: all })
if (fullLayout.entries.length !== graphData.entries.length) {
  problems.push(`全部展开时只放下 ${fullLayout.entries.length}/${graphData.entries.length} 个点`)
}
for (const entry of layout.entries) {
  if (entry.x < 0 || entry.y < 0 || entry.x > layout.canvas || entry.y > layout.canvas) {
    problems.push(`${entry.id} 落在画布外（${Math.round(entry.x)},${Math.round(entry.y)} / ${layout.canvas}）`)
    break
  }
}
// 点间距：小于 8px 就糊成一团
let minDistance = Infinity
for (let i = 0; i < layout.entries.length; i += 1) {
  for (let j = i + 1; j < layout.entries.length; j += 1) {
    const a = layout.entries[i]
    const b = layout.entries[j]
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (distance < minDistance) minDistance = distance
  }
}
if (minDistance < 8) problems.push(`最近两点只隔 ${minDistance.toFixed(1)}px（会糊成一团）`)
console.log(`web-check: canvas=${layout.canvas} points=${layout.entries.length} edges=${layout.edges.length} minDistance=${minDistance.toFixed(1)}`)

const CASES = [
  { name: 'web-wide-900', width: 900 },
  { name: 'web-narrow-420', width: 420 },
]

for (const item of CASES) {
  const body = render(
    reactStub.createElement(
      'div',
      { className: 'nw-panel', style: { width: `${item.width}px` } },
      reactStub.createElement(
        'div',
        { className: 'nw-inner' },
        reactStub.createElement(
          'div',
          { className: 'nw-card' },
          reactStub.createElement('div', { className: 'nw-card-h' }, reactStub.createElement('h3', { className: 'nw-card-t' }, '经验库')),
          internals.WebView({ t, layout, error: undefined, onOpen: () => {} }),
        ),
      ),
    ),
  )
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${TOKENS}</style><style>${css}</style></head><body>${body}</body></html>`
  const htmlPath = join(outDir, `${item.name}.html`)
  const pngPath = join(outDir, `${item.name}.png`)
  writeFileSync(htmlPath, html, 'utf8')
  execFileSync(
    chrome,
    [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=2',
      `--window-size=${item.width},900`, `--screenshot=${pngPath}`, '--virtual-time-budget=2000',
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'pipe' },
  )
  if (!existsSync(pngPath)) problems.push(`${item.name}: 截图没有生成`)
  console.log(`web-check: ${item.name} -> ${pngPath}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`web-check: ${problem}`)
  process.exit(1)
}
console.log('web-check: 通过')
