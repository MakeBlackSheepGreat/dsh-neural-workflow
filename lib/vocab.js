/**
 * 领域词汇表（学 clearAI `domain-language.js` 的思路）。
 *
 * 问题：证据的 `kind` 和组织它的 `node` 原本是**裸字符串**。打错一个字母
 * （`hypothesys`）不会报错，只会静默不匹配——图里那个节点永远绿不了，
 * 而账本看起来"有记录"。这是最难查的一类错。
 *
 * 这里的职责**只有 membership**：这个 node 存在吗、这个 kind 被这个节点接受吗。
 * 判据（C1–C6）仍然只有一份实现，在 `native/src/main.rs`；本模块是它的**前置投影**，
 * 用来把"字母打错"变成一句能改的话，不能代替判定——所以它只会**多拒**不会**多收**：
 * 任何本模块放行的输入，仍要过一遍中间件。
 *
 * 例外：`failure` 是审计事实，任何节点都接受（见 PROTOCOL.md §8）。
 */

import { GRAPH_DOC } from './graph.js'

/** 图里所有节点 id。 */
const NODES = new Map((GRAPH_DOC.nodes ?? []).map((node) => [node.id, node]))

/** 全部被接受的证据种类（并集），用于给"未知种类"提供候选。 */
const ALL_KINDS = [...new Set((GRAPH_DOC.nodes ?? []).flatMap((node) => node.evidenceKinds ?? []))].sort()

/** 审计事实：不是证据，不参与满足度，因此任何节点都接受。 */
export const FAILURE_KIND = 'failure'

/** 编辑距离（只用于候选提示，不是判据）。 */
function distance(left, right) {
  const a = String(left)
  const b = String(right)
  if (a === b) return 0
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index])
  for (let column = 1; column <= b.length; column += 1) rows[0][column] = column
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      )
    }
  }
  return rows[a.length][b.length]
}

/** 最接近的若干个候选（编辑距离 ≤ 阈值，或前缀相近）。 */
function candidates(value, pool, limit = 5) {
  return pool
    .map((item) => ({ item, score: distance(value.toLowerCase(), String(item).toLowerCase()) }))
    .filter((entry) => entry.score <= Math.max(2, Math.ceil(String(value).length / 3)))
    .sort((left, right) => left.score - right.score || String(left.item).localeCompare(String(right.item)))
    .slice(0, limit)
    .map((entry) => entry.item)
}

/** 某节点接受的种类。 */
export function kindsFor(nodeId) {
  return NODES.get(nodeId)?.evidenceKinds ?? []
}

/**
 * 校验一条证据的 `node` + `kind`。
 * 返回 `{ ok: true }` 或 `{ ok: false, code, message, candidates }`。
 */
export function validateEvidence(nodeId, kind) {
  const node = typeof nodeId === 'string' ? nodeId.trim() : ''
  const evidenceKind = typeof kind === 'string' ? kind.trim() : ''

  if (node === '') {
    return { ok: false, code: 'UNKNOWN_NODE', message: 'node 不能为空。', candidates: [...NODES.keys()].slice(0, 6) }
  }
  if (!NODES.has(node)) {
    return {
      ok: false,
      code: 'UNKNOWN_NODE',
      message: `图里没有节点 ${JSON.stringify(node)}。`,
      candidates: candidates(node, [...NODES.keys()]),
    }
  }
  if (evidenceKind === '') {
    return { ok: false, code: 'UNKNOWN_KIND', message: 'kind 不能为空。', candidates: kindsFor(node) }
  }
  // 审计事实：任何节点都接受，不参与满足度。
  if (evidenceKind === FAILURE_KIND) return { ok: true, audit: true }

  const accepted = kindsFor(node)
  if (accepted.length > 0 && !accepted.includes(evidenceKind)) {
    return {
      ok: false,
      code: 'UNKNOWN_KIND',
      message: `节点 ${node} 只接受 ${accepted.join(' / ')}，不接受 ${JSON.stringify(evidenceKind)}。`,
      candidates: candidates(evidenceKind, accepted.length > 0 ? accepted : ALL_KINDS),
    }
  }
  return { ok: true, audit: false }
}

/** 给面板/工具用的词表快照。 */
export function vocabulary() {
  return {
    nodes: [...NODES.values()].map((node) => ({ id: node.id, kinds: node.evidenceKinds ?? [], stage: node.stage, layer: node.layer })),
    kinds: ALL_KINDS,
    failureKind: FAILURE_KIND,
  }
}
