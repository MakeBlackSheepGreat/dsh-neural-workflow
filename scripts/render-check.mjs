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

if (problems.length > 0) {
  for (const problem of problems) console.error(`render-check: ${problem}`)
  process.exit(1)
}
console.log(`render-check: 通过（${registrations.length} 个 slot 的组件都能渲染）`)
