#!/usr/bin/env node
/**
 * 窄宽度**视觉**自检：把真实 CSS + 真实布局渲染成静态 HTML，再用无头 Chrome 截图。
 *
 * 为什么还要这一步：render-check 断言的是几何数值与文案，证明不了"看起来对不对"。
 * 用户报的那个 bug 是**视觉**问题（卡片被压成几十像素、中文逐字换行、
 * 图布看不见），所以这里必须真的看一眼渲染结果。
 *
 * 关键设计：宽度**两趟**。第一趟用空卡片量出面板内真实可用宽度，
 * 第二趟用那个宽度渲染图布——这和宿主里 ResizeObserver 量 `.nw-canvas-scroll`
 * 的做法一致。只塞一个"我以为的宽度"进去，就会测到一个宿主里不存在的状态。
 *
 * 用法：node scripts/visual-check.mjs [输出目录]
 * 退出码非 0 = 截图失败、页面横向溢出、或节点卡被压得过窄。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ?? join(root, '.visual')
mkdirSync(outDir, { recursive: true })

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const GRAPH = JSON.parse(readFileSync(join(root, 'graph/neural-paper-workflow.json'), 'utf8'))

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

/** CSS 从 bundle 里原样取出——截图用的必须是**上线那份**样式，不能是副本。 */
const cssStart = source.indexOf('const CSS = `') + 'const CSS = `'.length
const css = source.slice(cssStart, source.indexOf('`\n\n    /**', cssStart))

/**
 * 找 Chrome：优先环境变量，其次平台默认路径，最后 PATH。
 *
 * 为什么不能写死路径：CI（Linux）上没有 ms-playwright 目录，写死等于必挂；
 * 而"找不到就跳过"更糟——跳过让 CI 假绿，视觉回归从此不再保护任何东西。
 * 所以这里找不到就**明确报错并退出 1**，由 CI 负责把浏览器装好。
 *
 * 顺序：DSH_CHROME_PATH → PUPPETEER_EXECUTABLE_PATH → 平台默认 → PATH。
 */
function findChrome() {
  const fromEnv = ['DSH_CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']
  for (const name of fromEnv) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      const candidate = value.trim()
      if (existsSync(candidate)) return { path: candidate, via: name }
      throw new Error(`${name} 指向的 Chrome 不存在：${candidate}`)
    }
  }

  const defaults = [
    // Windows：ms-playwright 下载的 Chromium（版本号会变，按新→旧试）。
    'C:/Users/876762330/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    'C:/Users/876762330/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    // Linux：CI 上 apt 装的 chromium 通常落在 /usr/bin。
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // macOS。
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const candidate of defaults) {
    if (existsSync(candidate)) return { path: candidate, via: '平台默认路径' }
  }

  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return { path: candidate, via: 'PATH' }
    }
  }
  return undefined
}

const found = (() => {
  try {
    return findChrome()
  } catch (error) {
    console.error(`visual-check: ${error.message}`)
    process.exit(1)
  }
})()
if (found === undefined) {
  console.error(
    [
      'visual-check: 找不到无头 Chrome。',
      '请设置 DSH_CHROME_PATH（或 PUPPETEER_EXECUTABLE_PATH）指向 Chrome/Chromium 可执行文件，',
      '或安装到平台默认位置（Linux: /usr/bin/chromium 或 /usr/bin/google-chrome）。',
      '这一项不做静默跳过：跳过等于 CI 假绿。',
    ].join('\n'),
  )
  process.exit(1)
}
const chrome = found.path

const profileDir = join(outDir, '.chrome-profile')
/**
 * 无头 Chrome 的参数。
 *
 * `--no-sandbox` 在 Linux CI 上是**必需**的：容器里以受限命名空间运行，
 * Chrome 的 sandbox 起不来会直接 SIGABRT（abort，不是普通退出码）。
 * 本地 Windows/macOS 加了也无害，所以统一带上，避免"本地绿、CI 红"。
 * `--disable-dev-shm-usage` 同理：容器里 /dev/shm 常常只有 64MB，
 * 不加会在截图时随机崩。
 */
const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDir}`,
]

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** React 树 → HTML 字符串。`className` 必须落成 `class`，否则一条样式都不生效。 */
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
      const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
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

const verdict = {
  nodes: Object.fromEntries(
    GRAPH.nodes.map((node, index) => [
      node.id,
      { state: index < 4 ? 'satisfied' : index === 4 ? 'ready' : 'blocked', evidence: index < 4 ? 2 : 0, failures: 0, kinds: [] },
    ]),
  ),
  layers: GRAPH.layers.map((layer, index) => ({
    id: layer.id,
    satisfied: index === 0 ? 2 : 0,
    total: GRAPH.nodes.filter((node) => node.layer === layer.id).length,
  })),
  violations: [{ code: 'C3', constraint: 'C3', message: '下游节点在上游未满足时记录了证据', node: 'train' }],
  progress: { satisfied: 4, total: GRAPH.nodes.length },
  frontier: ['train'],
}

const RUNS = [
  { id: 'run-2', node: 'train', status: 'ok', startedAt: '2026-10-29T02:10:00.000Z', finishedAt: '2026-10-29T02:14:00.000Z' },
  { id: 'run-1', node: 'scope', status: 'failed', startedAt: '2026-10-29T01:50:00.000Z', finishedAt: '2026-10-29T01:52:00.000Z' },
]

const DICT = {
  title: '神经网络工作流',
  panel: '神经工作流',
  view: '工作流',
  progress: '进度',
  ready: '当前可推进',
  violations: '未通过约束',
  noViolations: '暂无违规',
  ledger: '证据账本',
  emptyLedger: '还没有证据。',
  satisfied: '已满足',
  blocked: '被上游阻塞',
  layers: '阶段层',
  evidence: '条证据',
  dualGate: '双门',
  anchors: '锚点',
  anchor: '锚点',
  stages: '个阶段',
  expandAll: '全部展开',
  collapseAll: '全部收起',
  collapse: '收起',
  gate: '门',
  gateCommands: '校验命令',
  needsAnchor: '需要锚点',
  noAnchor: '无需锚点',
  viewList: '列表',
  viewGraph: '图',
  runs: '阶段运行',
  runsNone: '还没有派发过阶段。',
  runsUnavailable: '运行登记不可用',
  runOk: '完成',
  runFailed: '失败',
  runRunning: '运行中',
}
const t = (key) => DICT[key] ?? key

const TOKENS = `:root{--dsw-alias-label-primary:#1a1a1a;--dsw-alias-label-secondary:#666;--dsw-alias-label-tertiary:#999;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#f2f2f2;--dsw-alias-border-l1:#ececec;--dsw-alias-border-l2:#dcdcdc;--dsw-alias-brand-primary:#3b6cf0;--dsw-alias-state-success-primary:#1a9c5b;--dsw-alias-state-error-primary:#d92d48;--dsw-alias-state-warn-primary:#b7791f;--dsw-alias-interactive-bg-hover:#eee}
body{margin:0;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#fff}`

/**
 * 造一页 HTML。`canvasWidth` 为 null 时图布位置放一个占位 div，
 * 用于第一趟量宽度；给了数字才真正渲染 Board。
 */
function buildHtml(stageWidth, canvasWidth) {
  const board =
    canvasWidth === null
      ? reactStub.createElement('div', { className: 'nw-canvas-scroll', id: 'measure' }, reactStub.createElement('div', { style: { width: '100%', height: '1px' } }))
      : internals.Board({ graph: GRAPH, verdict, t, lang: 'zh', width: canvasWidth })

  const body = render(
    reactStub.createElement(
      'div',
      { className: 'nw-panel' },
      reactStub.createElement(
        'div',
        { className: 'nw-inner' },
        reactStub.createElement('div', { className: 'nw-head' }, reactStub.createElement('h2', { className: 'nw-h1' }, t('title'))),
        reactStub.createElement('div', { className: 'nw-sub' }, '只读视图。所有操作通过工具 neural_flow 完成。'),
        reactStub.createElement(
          'div',
          { className: 'nw-kpis' },
          ...[
            ['进度', `${verdict.progress.satisfied}/${verdict.progress.total}`, '4 已满足'],
            ['当前可推进', String(verdict.frontier.length), '当前可推进'],
            ['被上游阻塞', String(GRAPH.nodes.length - 4), ''],
            ['未通过约束', String(verdict.violations.length), 'train'],
          ].map(([key, value, sub]) =>
            reactStub.createElement(
              'div',
              { className: 'nw-kpi', key },
              reactStub.createElement('div', { className: 'nw-kpi-k' }, key),
              reactStub.createElement('div', { className: 'nw-kpi-v' }, value),
              reactStub.createElement('div', { className: 'nw-kpi-s' }, sub),
            ),
          ),
        ),
        reactStub.createElement(
          'div',
          { className: 'nw-grid' },
          reactStub.createElement(
            'div',
            null,
            reactStub.createElement(
              'div',
              { className: 'nw-card' },
              reactStub.createElement('div', { className: 'nw-card-h' }, reactStub.createElement('h3', { className: 'nw-card-t' }, t('panel'))),
              board,
            ),
          ),
          reactStub.createElement(
            'div',
            null,
            reactStub.createElement('div', { className: 'nw-card' }, internals.Violations({ verdict, t, lang: 'zh', constraints: [] })),
            reactStub.createElement('div', { className: 'nw-card' }, internals.LayerBars({ graph: GRAPH, verdict, t, lang: 'zh' })),
            reactStub.createElement('div', { className: 'nw-card' }, internals.Runs({ runs: RUNS, error: undefined, t, lang: 'zh' })),
          ),
        ),
      ),
    ),
  )

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>${TOKENS}
/* 模拟右侧栏/窄窗口：宽度被外层定死，面板不许撑开。 */
.stage{width:${stageWidth}px;overflow:hidden}
</style>
<style>${css}</style></head>
<body><div class="stage">${body}</div></body></html>`
}

const PROBE_SCRIPT = `<script>
const panel = document.querySelector('.nw-panel')
const measure = document.getElementById('measure')
const scroll = document.querySelector('.nw-canvas-scroll')
const canvas = document.querySelector('.nw-canvas')
const rows = [...document.querySelectorAll('.nw-list-row')]
const nodes = [...document.querySelectorAll('.nw-node')]
// 两种视图都要认：窄容器默认列表、宽容器默认图。只数一种会把"另一个视图
// 正常渲染"误报成"一个节点都没画"。
const cards = nodes.length > 0 ? nodes : rows
const view = nodes.length > 0 ? 'graph' : rows.length > 0 ? 'list' : 'none'
const widths = cards.map((card) => Math.round(card.getBoundingClientRect().width))
const names = cards.map((card) => {
  const name = card.querySelector('.nw-node-name')
  const rect = name ? name.getBoundingClientRect() : null
  return rect === null ? null : Math.round(rect.height)
})
document.title = 'PROBE ' + JSON.stringify({
  panelScroll: panel.scrollWidth,
  panelClient: panel.clientWidth,
  // 用 stage 自身的溢出，而不是 document：stage 宽度正好等于视口，
  // 滚动条槽会被算成"文档溢出"，那是量具的假象，不是面板的毛病。
  stageOverflow: (() => {
    const stage = document.querySelector('.stage')
    return stage === null ? null : stage.scrollWidth - stage.clientWidth
  })(),
  available: measure ? Math.round(measure.clientWidth) : null,
  canvasW: canvas ? Math.round(canvas.getBoundingClientRect().width) : null,
  scrollClient: scroll ? scroll.clientWidth : null,
  scrollW: scroll ? scroll.scrollWidth : null,
  minCard: widths.length > 0 ? Math.min(...widths) : null,
  maxCard: widths.length > 0 ? Math.max(...widths) : null,
  cards: widths.length,
  view,
  // 中文逐字换行的直接证据：单行字高约 16px，两行以上说明被压窄了。
  maxNameHeight: names.length > 0 && names.every((n) => n !== null) ? Math.max(...names) : null,
  /**
   * 卡片内容是否溢出卡片本体。
   *
   * 这是漏过一次的检查：收起高度写死 96px 时，figure 的两个证据徽章换行后
   * 把 note 顶到了卡片外，看起来像徽章挂在边框上——而"卡片宽度、画布溢出"
   * 这几条全都通过。所以必须直接量内容盒与卡片盒的关系。
   */
  cardOverflow: nodes.map((card) => {
    const body = card.querySelector('.nw-node-hit')
    if (body === null) return null
    return Math.round(body.scrollHeight - card.clientHeight)
  }),
  // 列表行同理：行内容不得溢出行的边框。
  rowOverflow: rows.map((row) => Math.round(row.scrollHeight - row.clientHeight)),
  // 卡片之间是否重叠：同一层的相邻卡片最容易叠。
  cardOverlaps: (() => {
    const rects = cards.map((card) => {
      const r = card.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    })
    let hits = 0
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]
        const b = rects[j]
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits += 1
      }
    }
    return hits
  })(),
})
</script>`

function probe(htmlPath, stageWidth) {
  const probePath = htmlPath.replace(/\.html$/, '.probe.html')
  writeFileSync(probePath, readFileSync(htmlPath, 'utf8').replace('</body>', `${PROBE_SCRIPT}</body>`), 'utf8')
  // 探针必须和截图用**同一组**窗口参数：视口不同，量出来的宽度就不是截图里那个。
  const dom = execFileSync(
    chrome,
    [...chromeArgs, '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${stageWidth},1000`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(probePath).href],
    { stdio: 'pipe', encoding: 'utf8' },
  )
  const match = dom.match(/PROBE (\{.*?\})<\/title>/)
  return match === null ? null : JSON.parse(match[1])
}

const cases = [
  { name: 'right-sidebar-320', stage: 320 },
  { name: 'right-sidebar-420', stage: 420 },
  { name: 'narrow-window-600', stage: 600 },
  { name: 'full-panel-1100', stage: 1100 },
]

const problems = []
for (const item of cases) {
  const htmlPath = join(outDir, `${item.name}.html`)
  const pngPath = join(outDir, `${item.name}.png`)

  // 第一趟：量面板内真实可用宽度。
  writeFileSync(htmlPath, buildHtml(item.stage, null), 'utf8')
  const measured = probe(htmlPath, item.stage)
  if (measured === null || measured.available === null || measured.available <= 0) {
    problems.push(`${item.name}: 第一趟量不到可用宽度`)
    continue
  }
  const available = measured.available

  // 第二趟：按量到的宽度渲染图布，再截图 + 量布局。
  writeFileSync(htmlPath, buildHtml(item.stage, available), 'utf8')
  execFileSync(chrome, [...chromeArgs, '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${item.stage},1000`, `--screenshot=${pngPath}`, '--virtual-time-budget=2000', pathToFileURL(htmlPath).href], { stdio: 'pipe' })
  if (!existsSync(pngPath)) problems.push(`${item.name}: 截图没有生成`)

  const data = probe(htmlPath, item.stage)
  if (data === null) {
    problems.push(`${item.name}: 第二趟量不到布局`)
    continue
  }
  console.log(`visual-check: ${item.name} 可用宽 ${available} 探针 ${JSON.stringify(data)}`)

  if (data.stageOverflow !== null && data.stageOverflow > 0) problems.push(`${item.name}: 面板横向溢出 ${data.stageOverflow}px（右侧栏里内容会被裁掉）`)
  if (data.cards !== GRAPH.nodes.length) problems.push(`${item.name}: 只画出 ${data.cards}/${GRAPH.nodes.length} 个节点`)
  if (data.minCard !== null && data.minCard < 120) problems.push(`${item.name}: 节点卡最窄只有 ${data.minCard}px（中文会逐字换行）`)
  if (data.maxNameHeight !== null && data.maxNameHeight > 26) {
    problems.push(`${item.name}: 节点名最高 ${data.maxNameHeight}px（超过两行，说明被压窄了）`)
  }
  // 画布内容不得溢出它的滚动容器。这一条对**所有**宽度都成立：
  // 布局按可用宽度算尺寸，所以画布必须正好装下所有卡片，不该还要横向拖动。
  // 写死列宽时这里会露出马脚（画布 670、内容 758，最右两列被裁）。
  if (data.scrollW !== null && data.scrollClient !== null && data.scrollW > data.scrollClient + 1) {
    problems.push(`${item.name}: 画布内容 ${data.scrollW}px 溢出可视区 ${data.scrollClient}px（最右的列会被裁掉）`)
  }
  // 卡片内容不得溢出卡片本体。收起高度写死时 `figure` 的两个徽章换行会把
  // `note` 顶到卡片外，而上面几条全都通过——所以这一条必须单独量。
  for (const [index, overflow] of (data.cardOverflow ?? []).entries()) {
    if (overflow !== null && overflow > 1) {
      problems.push(`${item.name}: 第 ${index + 1} 张卡片内容溢出 ${overflow}px（徽章被顶到卡片外）`)
    }
  }
  if (typeof data.cardOverlaps === 'number' && data.cardOverlaps > 0) {
    problems.push(`${item.name}: 有 ${data.cardOverlaps} 对卡片相互重叠`)
  }
  for (const [index, overflow] of (data.rowOverflow ?? []).entries()) {
    if (overflow > 1) problems.push(`${item.name}: 第 ${index + 1} 行列表内容溢出 ${overflow}px`)
  }
  // 视图选择必须按容器宽度走：窄容器给列表、宽容器给图。
  if (available < 620 && data.view !== 'list') problems.push(`${item.name}: 窄容器应默认列表视图，实际 ${data.view}`)
  if (available >= 620 && data.view !== 'graph') problems.push(`${item.name}: 宽容器应默认图视图，实际 ${data.view}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`visual-check: ${problem}`)
  process.exit(1)
}
console.log(`visual-check: 通过（${cases.length} 个宽度，截图在 ${outDir}）`)
