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
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

if (problems.length > 0) {
  for (const problem of problems) console.error(`render-check: ${problem}`)
  process.exit(1)
}
console.log(`render-check: 通过（${registrations.length} 个 slot 的组件都能渲染）`)
