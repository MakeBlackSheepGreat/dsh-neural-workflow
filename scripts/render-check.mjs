#!/usr/bin/env node
/**
 * 离线跑一遍客户端 bundle：用最小 React 桩执行 apply()，并真正调用注册进来的组件。
 *
 * 为什么需要这个：`Slots.listSubTree` 只能证明**注册发生了**，证明不了
 * 图标或面板在渲染时不抛错。侧边栏"点了没反应/根本没出现"最常见的死因
 * 就是组件里某一行在渲染期抛了异常，而注册那一步早已成功。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

let registeredFactory
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registeredFactory = definition.factory
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })

/** 最小 React 桩：只提供本 bundle 用到的 API。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  // setter 直接改值：让 fetch 结果真的进入渲染，否则"英文模式无中文"
  // 的断言会因为没有图数据而假通过。值本身直接返回（不是包装对象）。
  useState: (initial) => {
    const box = { value: typeof initial === 'function' ? initial() : initial }
    const set = (next) => {
      box.value = typeof next === 'function' ? next(box.value) : next
    }
    return [box.value, set]
  },
  Fragment: 'Fragment',
}

// 执行 bundle（它会调用 window.__ModuleLoader__.load）
new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)

if (typeof registeredFactory !== 'function') {
  console.error('render-check: bundle 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

const moduleExports = registeredFactory((id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement }
  throw new Error(`未知依赖 ${id}`)
})

// 收集 apply() 里注册的组件与元数据
const registrations = []
const fakeCtx = {
  effect: (factory) => {
    const disposer = factory()
    return disposer
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => {
      const dict = {
        title: '神经网络工作流',
        subtitle: '阶段约束 · 证据账本 · 越序拦截',
        panel: '神经工作流',
        view: '工作流',
        progress: '进度',
        frontier: '当前可推进',
        violations: '未通过约束',
        noViolations: '暂无违规',
        ledger: '证据账本',
        emptyLedger: '还没有证据。',
        satisfied: '已满足',
        ready: '可推进',
        blocked: '被上游阻塞',
        degraded: '中间件不可用，面板只读',
        degradedHint: '运行 native/build.sh。',
        refresh: '刷新',
        selftest: '自检',
        selftestOk: '一致',
        selftestFail: '失败',
        layers: '阶段层',
        evidence: '条证据',
        blockedBy: '阻塞于',
        anchors: '锚点',
        openPanel: '打开面板',
      }
      return dict[key] ?? key
    },
  },
  slots: {
    inject: (name, factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register: (meta, component) => {
      registrations.push({ meta, component })
      return () => {}
    },
  },
}

moduleExports.apply(fakeCtx)

const problems = []
if (registrations.length !== 3) problems.push(`预期注册 3 个 slot，实际 ${registrations.length}`)

/** 递归渲染成字符串，任何抛错都算失败。宿主元素要占位，否则叶子节点会被误判成空。 */
function render(node, depth = 0) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => render(child, depth + 1)).join('')
  if (typeof node === 'object' && 'type' in node) {
    const { type, props, children } = node
    if (typeof type === 'function') return render(type(props), depth + 1)
    // 宿主元素：用一个有内容的标记代表它，避免 <path/> 这类叶子被当成空。
    return `<${type}>${render(children, depth + 1)}</${type}>`
  }
  return ''
}

/**
 * 真正调用每个注册的组件——这正是侧栏按钮与视图标签的渲染路径。
 * props 只给最小必需项：图标要 size，会话视图要 sessionId。
 */
for (const { meta, component } of registrations) {
  const props = { size: 18, active: true, sessionId: 'test-session', t: (key) => key }
  try {
    const output = render(component(props))
    if (meta.name === 'sidebar.panellist' && output === '') {
      problems.push('sidebar.panellist 图标渲染出空内容（侧边栏会看不见）')
    }
    if (meta.name === 'main' && output === '') problems.push('main 面板渲染出空内容')
    if (meta.name === 'conversation.view' && output === '') problems.push('conversation.view 渲染出空内容')
  } catch (error) {
    problems.push(`${meta.name} 组件渲染抛错：${error?.message ?? error}`)
  }
}

// label thunk 必须返回非空字符串，否则侧栏行没有可读标签
for (const { meta } of registrations) {
  if (typeof meta.label === 'function') {
    try {
      const label = meta.label()
      if (typeof label !== 'string' || label === '') problems.push(`${meta.name} 的 label 为空`)
    } catch (error) {
      problems.push(`${meta.name} 的 label 抛错：${error?.message ?? error}`)
    }
  }
}

/**
 * 标签回退：字典还没就绪时 `t` 会抛/返回空。侧栏行拿不到 label 就不渲染，
 * 所以这里**故意**把 t 换成会抛的实现，验证 label thunk 仍返回非空字符串。
 */
const throwingRegistrations = []
const throwingCtx = {
  effect: (factory) => factory(),
  locale: {
    register: () => () => {},
    bind: () => () => {
      throw new Error('locale not ready')
    },
  },
  slots: {
    inject: (name, factory) => factory(),
    register: (meta) => {
      throwingRegistrations.push(meta)
      return () => {}
    },
  },
}
moduleExports.apply(throwingCtx)
for (const meta of throwingRegistrations) {
  if (typeof meta.label !== 'function') continue
  try {
    const label = meta.label()
    if (typeof label !== 'string' || label === '') {
      problems.push(`字典不可用时 ${meta.name} 的 label 为空（侧栏会整行消失）`)
    }
  } catch (error) {
    problems.push(`字典不可用时 ${meta.name} 的 label 抛错：${error?.message ?? error}`)
  }
}

/**
 * 双语断言：`getLocale().active === 'en'` 时，渲染结果里**不应出现中文**。
 *
 * 这正是用户报的那个 bug：设置页英文、面板中文。修法是把图数据（节点/层名、
 * hint、gate）与违规消息都按同一个语言值挑选，而不是只切 UI 字典。
 */
const cjk = /[一-鿿]/
const GRAPH = JSON.parse(readFileSync(join(root, 'graph/neural-paper-workflow.json'), 'utf8'))
globalThis.fetch = (url) =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve(
        String(url).includes('/graph')
          ? { ok: true, graph: GRAPH, constraints: [], degraded: false, binary: null }
          : { ok: true, found: true, ledger: [], verdict: null, brief: null },
      ),
  })

const englishCtx = {
  effect: (factory) => factory(),
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
    getLocale: () => ({ active: 'en' }),
  },
  slots: {
    inject: (name, factory) => factory(),
    register: (meta, component) => {
      const props = { size: 18, active: true, sessionId: 'test-session', t: (key) => key }
      try {
        const output = render(component(props))
        if (typeof output === 'string' && cjk.test(output)) {
          problems.push(`英文模式下 ${meta.name} 渲染出中文：${output.slice(0, 120)}`)
        }
      } catch (error) {
        problems.push(`英文模式 ${meta.name} 渲染抛错：${error?.message ?? error}`)
      }
      return () => {}
    },
  },
}
moduleExports.apply(englishCtx)

// Panel 的图走异步 fetch，同步桩里拿不到；直接渲染 Board / LayerBars 才是
// 对"节点名与层名是否本地化"的真断言。
const probe = registeredFactory((id) => (id === 'react' ? reactStub : { jsx: reactStub.createElement, jsxs: reactStub.createElement }))
const internals = probe.__test__ ?? {}
if (typeof internals.Board !== 'function') {
  problems.push('render-check 需要 client.js 导出 __test__.Board 才能断言图数据本地化')
} else {
  const verdict = {
    nodes: { train: { state: 'ready', evidence: 0, failures: 0, kinds: [] } },
    layers: [{ id: 'L1', satisfied: 0, total: 1 }],
    violations: [{ code: 'C3', constraint: 'C3', message: '中文诊断句', node: 'train' }],
    progress: { satisfied: 0, total: 1 },
    frontier: ['train'],
  }
  const board = render(internals.Board({ graph: GRAPH, verdict, t: (key) => key, lang: 'en' }))
  if (cjk.test(board)) problems.push(`英文模式下图布出现中文：${board.slice(0, 160)}`)
  const boardZh = render(internals.Board({ graph: GRAPH, verdict, t: (key) => key, lang: 'zh' }))
  if (!cjk.test(boardZh)) problems.push('中文模式下图布应出现中文节点名，实际没有')

  const bars = render(internals.LayerBars({ graph: GRAPH, verdict, t: (key) => key, lang: 'en' }))
  if (cjk.test(bars)) problems.push(`英文模式下层进度出现中文：${bars.slice(0, 160)}`)

  const vio = render(internals.Violations({ verdict, t: (key) => key, lang: 'en', constraints: [] }))
  if (cjk.test(vio)) problems.push(`英文模式下违规卡出现中文诊断句：${vio.slice(0, 160)}`)
}

/**
 * 窄宽度排版断言（用户报的那个 bug）。
 *
 * 右侧栏只有 300 多像素：横排布局 4 列共 784px 塞不进去，绝对定位的卡片
 * 被压成几十像素宽，中文逐字换行，看起来就是"竖排单字"。
 * 这里对布局函数做**数值**断言，而不是看截图——截图会随窗口大小漂移。
 */
if (typeof internals.layout !== 'function') {
  problems.push('render-check 需要 client.js 导出 __test__.layout 才能断言窄宽度排版')
} else {
  const narrowWidth = 320
  const narrow = internals.layout(GRAPH, narrowWidth)
  if (narrow.orientation !== 'narrow') {
    problems.push(`容器宽 ${narrowWidth}px 时应选竖排布局，实际 ${narrow.orientation}`)
  }
  if (narrow.width > narrowWidth) {
    problems.push(`竖排布局宽度 ${narrow.width}px 超出容器 ${narrowWidth}px（会横向溢出）`)
  }
  if (narrow.nodeWidth < 120) {
    problems.push(`竖排布局节点卡只有 ${narrow.nodeWidth}px 宽（中文会逐字换行）`)
  }
  const seen = new Set()
  for (const node of GRAPH.nodes) {
    const position = narrow.positions.get(node.id)
    if (position === undefined) {
      problems.push(`竖排布局缺少节点 ${node.id} 的位置`)
      continue
    }
    const key = `${position.x},${position.y}`
    if (seen.has(key)) problems.push(`竖排布局里节点 ${node.id} 与其它节点重叠（${key}）`)
    seen.add(key)
    if (position.x + narrow.nodeWidth > narrow.width) {
      problems.push(`竖排布局节点 ${node.id} 右边界 ${position.x + narrow.nodeWidth} 超出画布 ${narrow.width}`)
    }
  }
  // 宽容器必须保持原来的横排：这是"整页面板"的形态，不能被窄版规则改坏。
  const wide = internals.layout(GRAPH, 1200)
  if (wide.orientation !== 'wide') problems.push(`容器宽 1200px 时应选横排布局，实际 ${wide.orientation}`)
  if (wide.positions.size !== narrow.positions.size) problems.push('两种布局的节点数量不一致')
  // 宽版画布不得超出可用宽度：4 列 × 196 写死时是 798px，
  // 而整页面板主列常常只有 670px，最右两列会被裁掉。
  for (const budget of [660, 700, 820, 1200]) {
    const fitted = internals.layout(GRAPH, budget)
    if (fitted.orientation !== 'wide') continue
    if (fitted.width > budget) {
      problems.push(`可用宽 ${budget}px 时画布仍有 ${fitted.width}px（右侧列会被裁掉）`)
    }
    for (const node of GRAPH.nodes) {
      const position = fitted.positions.get(node.id)
      if (position === undefined) continue
      if (position.x + fitted.nodeWidth > fitted.width + 1) {
        problems.push(`可用宽 ${budget}px 时节点 ${node.id} 右边界超出画布`)
      }
    }
    if (fitted.nodeWidth < 112) problems.push(`可用宽 ${budget}px 时节点卡被压到 ${fitted.nodeWidth}px`)
  }
  // 竖排丢了列位置，层的分组必须靠层标题补回来。
  const layerLabels = Array.isArray(narrow.layerLabels) ? narrow.layerLabels : []
  if (layerLabels.length !== GRAPH.layers.length) {
    problems.push(`竖排布局应输出 ${GRAPH.layers.length} 个层标题，实际 ${layerLabels.length}`)
  }
  // 首帧 / 离线渲染没有可用宽度：必须退回横排，不能抛错。
  const unknown = internals.layout(GRAPH, null)
  if (unknown.orientation !== 'wide') problems.push('宽度未知时应回退横排布局')
}

/**
 * 窄版 Board 真渲染：用 `width` 覆盖量测（离线没有 ResizeObserver），
 * 断言层标题与节点都出现、且英文模式下不露中文。
 */
if (typeof internals.Board === 'function') {
  const narrowVerdict = {
    nodes: { scope: { state: 'satisfied', evidence: 1, failures: 0, kinds: [] } },
    layers: [{ id: 'L0', satisfied: 1, total: 2 }],
    violations: [],
    progress: { satisfied: 1, total: 11 },
    frontier: ['develop'],
  }
  const narrowBoard = render(internals.Board({ graph: GRAPH, verdict: narrowVerdict, t: (key) => key, lang: 'en', width: 320 }))
  if (cjk.test(narrowBoard)) problems.push(`窄版英文图布出现中文：${narrowBoard.slice(0, 160)}`)
  for (const layer of GRAPH.layers) {
    const name = layer.name.en
    if (!narrowBoard.includes(name)) problems.push(`窄版图布缺少层标题「${name}」`)
  }
  for (const node of GRAPH.nodes) {
    if (!narrowBoard.includes(node.name.en)) problems.push(`窄版图布缺少节点「${node.name.en}」`)
  }
}

/**
 * 断点必须写在 @container 上，不能写在 @media 上。
 *
 * 右侧栏是"视口宽、面板窄"，`@media (max-width:980px)` 在桌面永远不成立，
 * 于是单列规则不生效——这正是窄宽度被压扁的直接成因。这条断言防止回退。
 */
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
if (!/@container\s+nwpanel/.test(clientSource)) {
  problems.push('client.js 缺少 @container nwpanel 断点（窄面板下排版不会自适应）')
}
if (/@media\s*\(\s*max-width/.test(clientSource)) {
  problems.push('client.js 仍用 @media (max-width) 做断点：右侧栏里视口不窄、面板窄，该规则不会触发')
}

/**
 * 右侧栏入口：与 dsh-context 走同一条两步注册路径。
 *
 * 这里用**带 sidebarRightTabs 的 ctx** 再跑一次 apply()，断言：
 * ① tab 类型被声明；② body 与 title 两个 keyed slot 按同一个 id 注册；
 * ③ guide 卡片带非空标题与描述（否则右栏"添加工具"里是一张空白卡）。
 */
const rightRegistrations = []
const rightTypes = []
const rightCtx = {
  effect: (factory) => factory(),
  locale: {
    register: () => () => {},
    bind: () => (key) => (key === 'view' ? 'Workflow' : key === 'panel' ? 'Neural flow' : key),
    getLocale: () => ({ active: 'en' }),
  },
  slots: {
    inject: (name, factory) => factory(),
    register: (meta, component) => {
      rightRegistrations.push({ meta, component })
      return () => {}
    },
  },
  inject: (deps, callback) => {
    if (!Array.isArray(deps) || !deps.includes('sidebarRightTabs')) {
      problems.push(`右侧栏注册的 inject 依赖不对：${JSON.stringify(deps)}`)
      return () => {}
    }
    return callback({
      ...rightCtx,
      sidebarRightTabs: {
        register: (definition) => {
          rightTypes.push(definition)
          return () => {}
        },
      },
    })
  },
}
moduleExports.apply(rightCtx)

if (rightTypes.length !== 1) {
  problems.push(`预期声明 1 个右侧栏 tab 类型，实际 ${rightTypes.length}`)
} else {
  const type = rightTypes[0]
  if (typeof type.id !== 'string' || type.id === '') problems.push('右侧栏 tab 类型缺少 id')
  if (type.kind !== type.id) problems.push('右侧栏 tab 类型的 kind 应与 id 一致（guide 按 kind 打开）')
  if (typeof type.title !== 'function' || type.title() === '') problems.push('右侧栏 tab 标题为空（页签无字）')
  const guide = Array.isArray(type.guide) ? type.guide : []
  if (guide.length === 0) problems.push('右侧栏 tab 类型没有 guide 卡片（添加工具里找不到入口）')
  for (const entry of guide) {
    if (typeof entry.title !== 'function' || entry.title() === '') problems.push('右侧栏 guide 卡片标题为空')
    if (typeof entry.description !== 'function' || entry.description() === '') problems.push('右侧栏 guide 卡片描述为空')
    if (typeof entry.icon !== 'function') problems.push('右侧栏 guide 卡片缺少图标')
    else if (render(entry.icon({ size: 16 })) === '') problems.push('右侧栏 guide 卡片图标渲染为空')
  }
}
const rightSlots = rightRegistrations.map((item) => item.meta.name)
for (const expected of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
  if (!rightSlots.includes(expected)) problems.push(`右侧栏缺少 ${expected} 注册`)
}
const PANEL_ID_RIGHT = rightTypes.length > 0 ? rightTypes[0].id : 'neural-workflow'
for (const { meta, component } of rightRegistrations) {
  // 同一份 apply() 也会注册左侧那三个 slot，这里只断言右侧栏的两条。
  if (typeof meta.name !== 'string' || !meta.name.startsWith('sidebar.right.')) continue
  if (meta.key !== PANEL_ID_RIGHT) problems.push(`${meta.name} 的 key 应为 ${PANEL_ID_RIGHT}，实际 ${meta.key}`)
  try {
    const output = render(component({ size: 16, sessionId: 'test-session' }))
    if (output === '') problems.push(`右侧栏 ${meta.name} 渲染出空内容`)
    if (cjk.test(output)) problems.push(`英文模式下右侧栏 ${meta.name} 渲染出中文：${output.slice(0, 120)}`)
  } catch (error) {
    problems.push(`右侧栏 ${meta.name} 渲染抛错：${error?.message ?? error}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`render-check: ${problem}`)
  process.exit(1)
}
console.log(`render-check: 通过（${registrations.length} 个 slot 的组件都能渲染）`)
