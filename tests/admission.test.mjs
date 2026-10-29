/**
 * 经验准入层的测试。
 *
 * 每条测试都对应一个**会骗人的具体情形**，而不是"能不能跑通"：
 *   ① 只有声明的条目凭相似度混进请求（污染）。
 *   ② `stage` 当成门禁 → 随机误杀（该字段 94% 是默认值）。
 *   ③ 预算超限静默截断 → "为什么少了"无从解释。
 *   ④ 双转义正则被当成"可用" → 形式化确认变成一句空话。
 *   ⑤ 淘汰理由用自由文本 → 无法统计、无法断言。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

import {
  ADMISSION,
  CONFIRMABILITY,
  EXCLUSION,
  ROLE,
  SUPPORT,
  admit,
  classify,
  compactAdmission,
  contextFromEvidence,
  confirmabilityOf,
  matchSignature,
  reasonLabel,
  renderAdmission,
  roleOf,
  stageOf,
  supportOf,
} from '../lib/admission.js'

/** 造一条最小经验。只写测试关心的字段，其余留空——避免测试假设无关字段存在。 */
function entry(extra = {}) {
  return { id: 'NP900', title: '样例', rec_approach: '做法说明', ...extra }
}

/** 真实库目录：拿真数据校验"数据事实"，而不是假设。 */
const KB_DIR = 'C:/Users/876762330/Desktop/projects/Neural_Paper_Skill/skills/neural-paper-workflow/knowledge/graph'
let library
try {
  library = readdirSync(KB_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(`${KB_DIR}/${name}`, 'utf8')))
} catch {
  library = undefined
}
const hasLibrary = Array.isArray(library) && library.length > 0

test('角色：失败模式优先于流程，流程优先于建议', () => {
  assert.equal(roleOf(entry({ ktype: 'error' })), ROLE.HAZARD)
  // critical 一律按失败模式对待：严重度高到会毁掉一轮工作。
  assert.equal(roleOf(entry({ severity: 'critical' })), ROLE.HAZARD)
  assert.equal(roleOf(entry({ verification_cmd: 'python check.py' })), ROLE.PROCEDURE)
  assert.equal(roleOf(entry({ rec_command: 'python run.py' })), ROLE.PROCEDURE)
  assert.equal(roleOf(entry({ principles: ['P-STAT-001'] })), ROLE.PRINCIPLE)
  assert.equal(roleOf(entry()), ROLE.GUIDANCE)
  // 空命令不算有命令：`"  "` 不是可执行的流程。
  assert.equal(roleOf(entry({ rec_command: '   ' })), ROLE.GUIDANCE)
})

test('支撑：引文 > 来源事件 > 只有声明', () => {
  assert.equal(supportOf(entry({ evidence: ['arXiv/xxx'] })), SUPPORT.CITED)
  assert.equal(supportOf(entry({ source_event: 'Project_A（2026-08-16）' })), SUPPORT.SOURCED)
  assert.equal(supportOf(entry()), SUPPORT.BARE)
  // 空数组 / 空串不算支撑：有字段名不等于有内容。
  assert.equal(supportOf(entry({ evidence: [] })), SUPPORT.BARE)
  assert.equal(supportOf(entry({ evidence: [''] })), SUPPORT.BARE)
  assert.equal(supportOf(entry({ source_event: '' })), SUPPORT.BARE)
  // source_event 为 null 是真实库里存在的形态（NP001），不能算来源。
  assert.equal(supportOf(entry({ source_event: null })), SUPPORT.BARE)
})

test('可确认性：有正则可匹配，其次有命令可复核', () => {
  assert.equal(confirmabilityOf(entry({ prescan_pattern: '(AUC|F1)' })), CONFIRMABILITY.SIGNATURE)
  assert.equal(confirmabilityOf(entry({ verification_cmd: 'python check.py' })), CONFIRMABILITY.COMMAND)
  assert.equal(confirmabilityOf(entry()), CONFIRMABILITY.NONE)
  // 正则优先于命令：正则能当场判定，比"去跑个命令"更强。
  assert.equal(
    confirmabilityOf(entry({ prescan_pattern: '(AUC|F1)', verification_cmd: 'python check.py' })),
    CONFIRMABILITY.SIGNATURE,
  )
})

test('双转义正则被标为损坏，而不是"可用"（假确认防护）', () => {
  // 写坏的真实形态：JSON 里多转义一层，编译能过但只匹配字面反斜杠。
  const broken = classify(entry({ prescan_pattern: 'p\\\\s*[<≤]\\\\s*0\\\\.05' }))
  assert.equal(broken.signatureBroken, true, '双转义必须被识别')
  assert.equal(broken.signatureCompiles, false, '损坏的正则不能被算作可用')
  // 它绝不能匹配正常文本——否则形式化确认就是假的。
  assert.equal(matchSignature(broken, '主表 p<0.05'), undefined)

  const good = classify(entry({ prescan_pattern: 'p\\s*[<≤]\\s*0\\.05' }))
  assert.equal(good.signatureBroken, false)
  assert.equal(good.signatureCompiles, true)
  assert.equal(matchSignature(good, '主表 p<0.05 显著')?.match, 'p<0.05')
})

test('语法错的正则也算损坏（不能静默吞掉）', () => {
  const bad = classify(entry({ prescan_pattern: '(未闭合' }))
  assert.equal(bad.signatureCompiles, false)
  assert.equal(bad.signatureBroken, true)
})

test('准入默认门槛：只有声明的条目进不来', () => {
  const candidates = [entry({ id: 'NP901' }), entry({ id: 'NP902', evidence: ['arXiv/x'] })]
  const result = admit(candidates, { budget: 10000 })
  assert.deepEqual(result.admitted.map((item) => item.id), ['NP902'])
  assert.equal(result.rejected[0].id, 'NP901')
  assert.equal(result.rejected[0].reason, EXCLUSION.FLOOR)
  // 淘汰理由必须是可枚举常量，不是自由文本。
  assert.equal(reasonLabel(result.rejected[0].reason), '支撑不足')
})

test('形式化确认可以推翻门槛：只有声明但正则命中 → 准入', () => {
  const candidates = [entry({ id: 'NP903', prescan_pattern: 'AUC\\s*[=：:]\\s*0\\.9[0-9]{2}' })]
  // 不命中 → 淘汰
  const miss = admit(candidates, { context: '模型还没开始训练', budget: 10000 })
  assert.equal(miss.admitted.length, 0)
  assert.equal(miss.rejected[0].reason, EXCLUSION.FLOOR)

  // 命中 → 准入，且理由写明是上下文确认
  const hit = admit(candidates, { context: 'best fold: AUC=0.931 on test', budget: 10000 })
  assert.equal(hit.admitted.length, 1)
  assert.equal(hit.admitted[0].reason, ADMISSION.CONFIRMED)
  assert.equal(hit.admitted[0].confirmedBy, ADMISSION.CONFIRMED)
  // 命中片段要说清楚依据是什么，否则"确认"不可复核。
  assert.equal(hit.admitted[0].evidence.match, 'AUC=0.931')
  assert.equal(hit.counts.confirmed, 1)
})

test('stage 只标注、不淘汰（防"用默认值当门禁"的误杀）', () => {
  /**
   * 这是本文件最重要的一条回归。
   *
   * 库里 `stage` 94% 是没填的默认值（内容属于训练的 182 条里 172 条标 conception）。
   * 曾经把它当硬性门禁，结果 12 条候选被误杀 5 条。
   * 现在必须：阶段不符仍可准入，但带上 stageFit=mismatch 让调用方看得见。
   */
  const candidates = [entry({ id: 'NP904', stage: 'validation', evidence: ['arXiv/x'] })]
  const result = admit(candidates, { stage: 'training', budget: 10000 })
  assert.equal(result.admitted.length, 1, '阶段不符不应阻断准入')
  assert.equal(result.admitted[0].stageFit, 'mismatch', '但必须标注出来')
  // 淘汰里不许出现 stage 相关理由。
  assert.ok(!result.rejected.some((item) => String(item.reason).includes('stage')), '不得有 stage 淘汰理由')
})

test('stageFit：未标注时是 unset，对得上时是 exact', () => {
  assert.equal(stageOf(undefined, 'training'), 'unset')
  assert.equal(stageOf('training', undefined), 'unset')
  assert.equal(stageOf('training', 'training'), 'exact')
  assert.equal(stageOf('validation', 'training'), 'mismatch')
})

test('预算：超限要记账，不许静默截断', () => {
  const big = 'x'.repeat(100)
  const candidates = [
    entry({ id: 'NP905', evidence: ['arXiv/x'], rec_approach: big }),
    entry({ id: 'NP906', evidence: ['arXiv/x'], rec_approach: big }),
  ]
  const result = admit(candidates, { budget: 150 })
  assert.equal(result.admitted.length, 1, '只放得下一条')
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, EXCLUSION.BUDGET)
  assert.equal(result.counts.excludedBy[EXCLUSION.BUDGET], 1)
  // 用掉的字数不许超过预算。
  assert.ok(result.used <= 150, `used=${result.used} 超过预算 150`)
})

test('去重：同一条经验只进一次', () => {
  const same = entry({ id: 'NP907', evidence: ['arXiv/x'] })
  const result = admit([same, { ...same }, { ...same }], { budget: 10000 })
  assert.equal(result.admitted.length, 1)
  assert.equal(result.counts.candidates, 1)
})

test('无效条目：缺 id 被拒且不崩', () => {
  const result = admit([{ title: '没有 id' }, null, entry({ id: 'NP908', evidence: ['arXiv/x'] })], { budget: 10000 })
  assert.equal(result.admitted.length, 1)
  assert.equal(result.counts.excludedBy[EXCLUSION.INVALID], 2)
})

test('排序：失败模式优先，同一份输入两次结果一致', () => {
  const candidates = [
    entry({ id: 'NP911', evidence: ['arXiv/x'], rec_command: 'python run.py' }), // procedure
    entry({ id: 'NP912', evidence: ['arXiv/x'], ktype: 'error' }), // hazard
    entry({ id: 'NP913', evidence: ['arXiv/x'], principles: ['P-X'] }), // principle
  ]
  const first = admit(candidates, { budget: 10000 })
  assert.deepEqual(first.admitted.map((item) => item.role), ['hazard', 'principle', 'procedure'])
  const second = admit([...candidates].reverse(), { budget: 10000 })
  assert.deepEqual(
    first.admitted.map((item) => item.id),
    second.admitted.map((item) => item.id),
    '输入顺序不应影响输出顺序',
  )
})

test('放宽门槛到 bare 时，无支撑条目可进且汇总里说明已放宽', () => {
  const result = admit([entry({ id: 'NP914' })], { floor: SUPPORT.BARE, budget: 10000 })
  assert.equal(result.admitted.length, 1)
  assert.match(result.summary, /已放宽/)
})

test('渲染：每条都带理由，无确认依据的明确标注', () => {
  const result = admit(
    [
      entry({ id: 'NP915', title: '有引文的建议', evidence: ['arXiv/x'], rec_approach: '照这个做' }),
      entry({ id: 'NP916', title: '有命令的流程', verification_cmd: 'python g.py' }),
    ],
    { budget: 10000 },
  )
  const text = renderAdmission(result)
  assert.match(text, /NP915/)
  assert.match(text, /有引文/, '必须写明凭什么信它')
  assert.match(text, /有验证命令/, '有命令的条目要标明可复核')
  // 汇总行也要在，否则读者不知道淘汰了什么。
  assert.match(text, /准入 \d+ 条/)
})

test('空候选不产生空字符串噪声，但要有一句说明', () => {
  const result = admit([], { budget: 1000 })
  assert.equal(result.admitted.length, 0)
  assert.equal(renderAdmission(result), '')
  assert.equal(result.summary, '本轮没有候选经验。')
})

test('真实库数据事实：可用签名 19 条、损坏 3 条', { skip: !hasLibrary }, () => {
  /**
   * 这条守的是**数据事实**，不是代码逻辑。
   *
   * 文件头声称"非空 22 条、4 条双转义损坏、可用 18 条，占 2.9%"。
   * 如果哪天数据被修好（或继续坏下去），这条会红——那正是需要更新说明的时候，
   * 而不是让文档悄悄与现实脱节。
   */
  const pictures = library.map((item) => classify(item)).filter(Boolean)
  const signatures = pictures.filter((item) => item.confirmability === CONFIRMABILITY.SIGNATURE)
  assert.equal(signatures.length, 22, `非空正则应为 22 条，实际 ${signatures.length}`)
  const broken = signatures.filter((item) => item.signatureBroken)
  // 3 条双转义写坏。NP019 的 \{ 是合法转义，不在其中——
  // 早期用"含任意反斜杠"当判据，把它也误判成损坏了。
  assert.equal(broken.length, 3, `双转义损坏应为 3 条，实际 ${broken.length}`)
  assert.deepEqual(broken.map((item) => item.id).sort(), ['NP001', 'NP004', 'NP005'])
  const usable = signatures.filter((item) => item.signatureCompiles)
  assert.equal(usable.length, 19, `可用签名应为 19 条，实际 ${usable.length}`)
})

test('真实库数据事实：status 无区分力、stage 高度集中', { skip: !hasLibrary }, () => {
  // 这两条是"为什么不能用它们过滤"的依据，落在测试里防止有人后来拿它当门禁。
  // status 里除 'formal' 外只有空值——没有任何一条处于草稿/失效等其它状态，
  // 所以它无法用来区分"这条经验可信到什么程度"。
  const statuses = new Set(library.map((item) => item.status ?? ''))
  const meaningful = [...statuses].filter((value) => value !== '')
  assert.deepEqual(meaningful, ['formal'], `status 的有意义取值应只有 formal，实际 ${meaningful.join(',')}`)
  const conception = library.filter((item) => item.stage === 'conception').length
  assert.ok(conception / library.length > 0.9, `conception 占比应超过 90%，实际 ${conception}/${library.length}`)
})

test('真实库：对一段真实论文症状做准入，结果可解释', { skip: !hasLibrary }, async () => {
  const result = admit(library, {
    stage: 'validation',
    // 一段真实的、含多重比较问题的文本。
    context: '主表 p<0.05，但同时检验了 8 个假设，未做 FDR 校正；best fold AUC=0.941 直接写进结论',
    budget: 6000,
  })
  // 默认门槛下只放支撑等级够的条目：cited/sourced 之外的一律进不来。
  assert.ok(result.admitted.length > 0, '真实库应当准入一些条目')
  assert.ok(result.admitted.length < library.length, '不该把全库塞进请求')
  for (const item of result.admitted) {
    // 准入只有两条通道：有支撑（引文/来源）或可复核（有验证命令）。
    // 只有声明又不可复核的条目，绝不许进。
    const traceable = [SUPPORT.CITED, SUPPORT.SOURCED].includes(item.support)
    const checkable = item.confirmability === CONFIRMABILITY.COMMAND
    assert.ok(traceable || checkable, `${item.id} 支撑 ${item.support}、可确认性 ${item.confirmability}，不该进默认门槛`)
  }
  // 每一条准入都必须说得出理由。
  for (const item of result.admitted) {
    assert.ok(typeof item.reason === 'string' && item.reason !== '', `${item.id} 缺准入理由`)
    assert.match(reasonLabel(item.reason), /引文|来源|验证|确认/)
  }
  // 汇总里的数字必须与数组长度一致，否则面板和提示词会各说一套。
  assert.equal(result.counts.admitted, result.admitted.length)
  assert.equal(result.counts.rejected, result.rejected.length)
})

test('contextFromEvidence：把账本压成可匹配正文，并有总量上限', () => {
  const evidence = [
    { node: 'train', kind: 'log', anchors: [{ path: 'runs/train.log' }], note: 'loss 在 epoch 12 后不再下降' },
    { node: 'validate', kind: 'metric', note: 'best fold AUC=0.941' },
  ]
  const text = contextFromEvidence(evidence, '未通过约束：C3 越序')
  // 关键字段必须都进得来，否则签名匹配拿不到材料。
  assert.match(text, /loss 在 epoch 12 后不再下降/)
  assert.match(text, /AUC=0\.941/)
  assert.match(text, /C3 越序/)
  // 嵌套的数组/对象也要走到，不能只看顶层。
  assert.match(text, /runs\/train\.log/)

  // 上限：这是给正则用的材料，不是要索引全文。
  const huge = { note: 'x'.repeat(50000) }
  const capped = contextFromEvidence(huge)
  assert.equal(capped.length, 20000, `应截到 20000 字，实际 ${capped.length}`)

  // 空输入不产生垃圾。
  assert.equal(contextFromEvidence([]), '')
  assert.equal(contextFromEvidence(undefined), '')
})

test('contextFromEvidence 喂给签名：账本里的指标能触发确认', () => {
  // 端到端：账本文本 → 准入。这条确保"确认"不是孤立的单元测试，而是真能连起来。
  const candidate = entry({ id: 'NP920', prescan_pattern: 'AUC\s*[=：:]\s*0\.9[0-9]{2}' })
  const context = contextFromEvidence([{ note: 'best fold AUC=0.931 on test' }])
  const result = admit([candidate], { context, budget: 10000 })
  assert.equal(result.admitted.length, 1)
  assert.equal(result.admitted[0].confirmedBy, ADMISSION.CONFIRMED)
})

test('compactAdmission：给工具结果的形式只留 id/标题/理由，不带正文', () => {
  const result = admit(
    [entry({ id: 'NP921', title: '很长的正文', evidence: ['arXiv/x'], rec_approach: '正'.repeat(500) })],
    { budget: 10000 },
  )
  const compact = compactAdmission(result)
  assert.equal(compact.admitted.length, 1)
  assert.equal(compact.admitted[0].id, 'NP921')
  assert.equal(compact.admitted[0].reason, ADMISSION.CITED)
  // 正文不许进工具结果——那会把工具回包撑成一份文档。
  assert.equal(compact.admitted[0].body, undefined)
  // 汇总必须和完整报告一致，面板与提示词不能各说一套。
  assert.equal(compact.summary, result.summary)
  assert.equal(compact.counts.admitted, result.admitted.length)
  // null 输入不炸。
  assert.equal(compactAdmission(null), null)
})
