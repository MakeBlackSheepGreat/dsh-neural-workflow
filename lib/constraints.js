/**
 * 六条约束的**人读目录**（数据，不是判据）。
 *
 * 判据只有一份实现：`native/src/main.rs`。这里只写给人看的话，
 * 面板和提示词引用它，绝不用它判定——两套判据必然漂移。
 *
 * 每条都带中英两份：界面语言跟随 DSH 的语言设置（客户端按当前语言挑选）。
 * 中间件输出的 `message` 是中文句子，客户端另按 `code` 生成本地化说明，
 * 所以英文界面下不会出现中文违规句子。
 */

export const CONSTRAINT_DOC = [
  {
    code: 'C1',
    key: 'REF_UNKNOWN_NODE',
    text: '引用完整性：证据不能指向图里不存在的节点。',
    textEn: 'Reference integrity: evidence may not point at a node the graph does not have.',
  },
  {
    code: 'C2',
    key: 'KIND_NOT_ACCEPTED',
    text: '种类匹配：节点只接受它声明的证据种类。',
    textEn: 'Kind match: a node only accepts the evidence kinds it declares.',
  },
  {
    code: 'C3',
    key: 'OUT_OF_ORDER',
    text: '准入先于推进：上游未满足就落下游证据即越序。',
    textEn: 'Admission before advance: evidence on a downstream node whose upstream is unsatisfied is out of order.',
  },
  {
    code: 'C4',
    key: 'EVIDENCE_UNANCHORED',
    text: '可追溯：要求锚点的节点，证据必须带 anchors[].path。',
    textEn: 'Traceability: nodes that require anchors need anchors[].path.',
  },
  {
    code: 'C5',
    key: 'UNSUPPORTED_COMPLETION',
    text: '终局有据：必达节点未全满足时，不许声明完成。',
    textEn: 'Completion needs support: a completion claim is refused while a mandatory node is still open.',
  },
  {
    code: 'C6',
    key: 'EMPTY_EVIDENCE',
    text: '证据完整：kind 与 node 都不许为空。',
    textEn: 'Evidence completeness: kind and node may not be empty.',
  },
]

/** 按语言取一条约束的人读文本。 */
export function constraintText(entry, lang) {
  if (entry === null || typeof entry !== 'object') return ''
  if (lang === 'en') return entry.textEn ?? entry.text ?? ''
  return entry.text ?? entry.textEn ?? ''
}
