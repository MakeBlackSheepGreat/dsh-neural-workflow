/**
 * 提示词与面板共用的文字渲染（host 平面，纯函数）。
 *
 * 一处实现、两处消费：`systemPrompt` 段落与 `/api/neural-workflow/state` 的 `brief`
 * 都调这里——面板说的和模型看到的必须是同一份判断。
 */

import { CONSTRAINT_DOC } from './constraints.js'
import { GRAPH_DOC } from './graph.js'

export { GRAPH_DOC, CONSTRAINT_DOC }

/**
 * 把一次判定压成给模型读的几行。
 * 空判定返回空串——提示词不该为"什么都没发生"占位。
 */
export function renderBrief(verdict) {
  if (verdict === null || typeof verdict !== 'object') return ''
  const lines = []
  const progress = verdict.progress ?? {}
  const frontier = Array.isArray(verdict.frontier) ? verdict.frontier : []
  const violations = Array.isArray(verdict.violations) ? verdict.violations : []

  if (typeof progress.satisfied === 'number' && typeof progress.total === 'number' && progress.total > 0) {
    const ready = frontier.length === 0 ? '（无，先补齐上游）' : frontier.join(', ')
    lines.push(`工作流进度 ${progress.satisfied}/${progress.total}；当前可推进：${ready}`)
  }
  if (violations.length > 0) {
    lines.push(`未通过约束 ${violations.length} 条：`)
    for (const item of violations.slice(0, 6)) {
      lines.push(`- ${item.constraint ?? item.code} ${item.message ?? ''}`)
    }
    if (violations.length > 6) lines.push(`- …另有 ${violations.length - 6} 条`)
  }
  return lines.join('\n')
}

/** 面板用：把判定拆成可直接渲染的分组。 */
export function brief(verdict) {
  if (verdict === null || typeof verdict !== 'object') return null
  const nodes = verdict.nodes ?? {}
  const values = Object.values(nodes)
  return {
    progress: verdict.progress ?? { satisfied: 0, total: 0 },
    frontier: Array.isArray(verdict.frontier) ? verdict.frontier : [],
    layers: Array.isArray(verdict.layers) ? verdict.layers : [],
    violations: Array.isArray(verdict.violations) ? verdict.violations : [],
    counts: {
      satisfied: values.filter((node) => node?.state === 'satisfied').length,
      ready: values.filter((node) => node?.state === 'ready').length,
      blocked: values.filter((node) => node?.state === 'blocked').length,
    },
    text: renderBrief(verdict),
  }
}
