/**
 * 六条约束的**人读目录**（数据，不是判据）。
 *
 * 判据只有一份实现：`native/src/main.rs`。这里只写给人看的话，
 * 面板和提示词引用它，绝不用它判定——两套判据必然漂移。
 *
 * 值同时承担两件事：`code`（机器读，与中间件输出一致）与 `text`（人读）。
 */

export const CONSTRAINT_DOC = [
  {
    code: 'C1',
    key: 'REF_UNKNOWN_NODE',
    text: '引用完整性：证据不能指向图里不存在的节点。',
  },
  {
    code: 'C2',
    key: 'KIND_NOT_ACCEPTED',
    text: '种类匹配：节点只接受它声明的证据种类。',
  },
  {
    code: 'C3',
    key: 'OUT_OF_ORDER',
    text: '准入先于推进：上游未满足就落下游证据即越序。',
  },
  {
    code: 'C4',
    key: 'EVIDENCE_UNANCHORED',
    text: '可追溯：要求锚点的节点，证据必须带 anchors[].path。',
  },
  {
    code: 'C5',
    key: 'UNSUPPORTED_COMPLETION',
    text: '终局有据：必达节点未全满足时，不许声明完成。',
  },
  {
    code: 'C6',
    key: 'EMPTY_EVIDENCE',
    text: '证据完整：kind 与 node 都不许为空。',
  },
]
