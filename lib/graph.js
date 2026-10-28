/**
 * 工作流图（数据）。改阶段/门禁只改 `graph/neural-paper-workflow.json`，
 * 不改代码——学 dsh-ops 的数据/代码分离。
 *
 * 构建期由 `scripts/build.mjs` 把 JSON 生成成 `lib/graph-data.js`；运行期不读盘，
 * 于是发行物可以是纯 JS（`files` 里不必带 graph/ 目录，也不依赖 CWD）。
 */

import { GRAPH_DATA } from './graph-data.js'

/** 唯一的工作流图：阶段节点 + 数据依赖边。 */
export const GRAPH_DOC = GRAPH_DATA
