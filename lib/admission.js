/**
 * 经验准入层：决定哪一条经验进入模型请求，并留下可解释的记录。
 *
 * 为什么需要这一层——下面每个数字都是跑出来的，不是设想（613 条实测）：
 *
 *   支撑：     cited 102（有外部引文）/ sourced 496（有来源事件）/ bare 15
 *   角色：     hazard 28 / procedure 35 / guidance 549 / principle 1
 *   可确认性： signature 22（其中 19 可用）/ command 40 / none 551
 *
 * 四个必须先说清楚的事实，因为它们决定了这一层能承诺什么：
 *
 * ① `status` 字段 613 条**全是 `formal`**（只有 2 条为空），`stage` 有 572 条
 *    挤在 `conception`。这两个字段不携带区分力——按它们过滤等于没过滤。
 *
 * ② `stage` 不能当门禁。按内容关键词反查：**内容明显属于训练的 182 条里有
 *    172 条被标成 `conception`**，验证类 123/136、写作类 21/24 同样如此。
 *    这个字段基本是没填的默认值，用它做硬性淘汰等于随机误杀。所以 stage
 *    只作为 `stageFit` 标注参与排序与解释，**不参与准入**。
 *
 * ③ `prescan_pattern` 键存在 593 条，但**非空只有 22 条**，其中 3 条是双重
 *    转义写坏的（NP001 / NP004 / NP005：多转义一层后只匹配字面反斜杠）。
 *    真正可用的签名 **19 条，占 3.1%**。所以"正则确认"是窄路径，不是主线；
 *    主线是支撑门槛。判据必须是"两个连续反斜杠"——NP019 的 `\{` 是合法
 *    转义，用"含任意反斜杠"当判据会把一切正常正则误判成损坏。
 *
 * ④ 原来只输出 `{id, title}`。一条只有一段建议文本的条目，和一条有论文引文
 *    支撑的条目，以**同样的身份**静默进入请求。这正是 ThoughtDAG 指出的
 *    「上下文被污染」：看得见聊了什么，看不见**为什么这段历史进了请求**，
 *    于是也无法删掉一条线让上下文变干净。
 *
 * 本层做三件事，对应三个需求：
 *
 *   ① 区分 —— 每条经验算两个**独立**属性：`role`（它是什么种类）与
 *      `support`（凭什么信它）。两轴不能混：正则能匹配不代表建议为真，
 *      只代表**问题可被检出**。
 *
 *   ② 确认 —— 门槛不是分数，是判据。准入只有两条通道：
 *      · 有支撑（引文 / 来源事件），理由如实写明是哪一个；
 *      · 或可复核（有 `verification_cmd`）——能跑一下验真假，本身就是凭据。
 *      既无支撑又不可复核的条目**不进**，除非它的 `prescan_pattern`
 *      真的匹配当前上下文；那是形式化确认，不是相似度。
 *
 *   ③ 可解释 —— 每个候选都留下 `{admitted, reason, stageFit}`，被拒的也留、
 *      并带可枚举的淘汰原因常量。淘汰理由若是自由文本，就无法统计也无法测试。
 *
 * 只读：本层不写库、不改条目，也不猜作者意图去反解写坏的转义。
 * 它只决定"这次请求里放什么"，以及为什么。
 */

/**
 * 角色：这条经验是什么种类的东西。
 *
 * 区分的意义在于**进入上下文的方式不同**：
 * 失败模式要以警告出现（它会让你出错），流程要以步骤出现（照着做），
 * 原则要以门禁出现（必须满足），参考资料只是可查的背景。
 */
export const ROLE = {
  HAZARD: 'hazard',
  PROCEDURE: 'procedure',
  PRINCIPLE: 'principle',
  /** 有建议、无命令：`rec_approach` 是一段做法描述，照它做但不靠脚本复核。 */
  GUIDANCE: 'guidance',
}

/**
 * 支撑等级：凭什么信它。这是**独立的第二个轴**。
 *
 * `cited`   —— 有外部引文（论文/基准），可回溯。
 * `sourced` —— 有来源事件（本项目里发生过的会话事件），可追溯但无外部引证。
 * `bare`    —— 只有声明本身。库里 467 条属于这一级。
 */
export const SUPPORT = {
  CITED: 'cited',
  SOURCED: 'sourced',
  BARE: 'bare',
}

/** 支撑等级的序（高者优先进入上下文）。 */
const SUPPORT_RANK = { cited: 3, sourced: 2, bare: 1 }

/**
 * 可确认性：现在能不能**核**它。同样是独立轴。
 *
 * `signature` —— 有 `prescan_pattern`，可对当前上下文正文做正则匹配（形式化确认）。
 * `command`   —— 有 `verification_cmd`，可执行复核。
 * `none`      —— 两者都没有，只能信或不信。
 */
export const CONFIRMABILITY = {
  SIGNATURE: 'signature',
  COMMAND: 'command',
  NONE: 'none',
}

/** 淘汰理由。必须是可枚举常量——自由文本的拒绝理由无法统计，也无法测试。 */
export const EXCLUSION = {
  FLOOR: 'support_below_floor',
  BUDGET: 'over_budget',
  INVALID: 'invalid_entry',
}

/** 准入理由。 */
export const ADMISSION = {
  CONFIRMED: 'confirmed_by_signature',
  VERIFIED: 'has_verification_command',
  CITED: 'has_citation',
  SOURCED: 'has_source_event',
}

/**
 * 阶段标注是否对得上。只用于排序与解释，**不**用于准入（原因见文件头）。
 */
export function stageOf(entryStage, targetStage) {
  if (targetStage === undefined || entryStage === undefined) return 'unset'
  return entryStage === targetStage ? 'exact' : 'mismatch'
}

/** 依据条目结构判角色。顺序有意义：先认最具体的。 */
export function roleOf(entry) {
  if (entry === null || typeof entry !== 'object') return ROLE.GUIDANCE
  // 失败模式：已经发生过、会再发生的坑。critical 一律按失败模式对待。
  if (entry.ktype === 'error' || entry.severity === 'critical') return ROLE.HAZARD
  // 流程：能照做的东西。有命令才算，光有描述不算——描述无法执行。
  if (
    (typeof entry.rec_command === 'string' && entry.rec_command.trim() !== '') ||
    (typeof entry.verification_cmd === 'string' && entry.verification_cmd.trim() !== '')
  ) {
    return ROLE.PROCEDURE
  }
  // 原则：挂了 P-xxx 原则码的，是必须满足的门禁，不是可选建议。
  if (Array.isArray(entry.principles) && entry.principles.length > 0) return ROLE.PRINCIPLE
  return ROLE.GUIDANCE
}

/** 依据条目出处判支撑等级。 */
export function supportOf(entry) {
  if (entry === null || typeof entry !== 'object') return SUPPORT.BARE
  if (Array.isArray(entry.evidence) && entry.evidence.some((item) => typeof item === 'string' && item !== '')) {
    return SUPPORT.CITED
  }
  const sourced =
    (typeof entry.source_event === 'string' && entry.source_event !== '') ||
    (typeof entry.metrics_confidence === 'string' && entry.metrics_confidence !== '')
  return sourced ? SUPPORT.SOURCED : SUPPORT.BARE
}

/** 依据可执行性判可确认性。 */
export function confirmabilityOf(entry) {
  if (entry === null || typeof entry !== 'object') return CONFIRMABILITY.NONE
  if (typeof entry.prescan_pattern === 'string' && entry.prescan_pattern.trim() !== '') return CONFIRMABILITY.SIGNATURE
  if (typeof entry.verification_cmd === 'string' && entry.verification_cmd.trim() !== '') return CONFIRMABILITY.COMMAND
  return CONFIRMABILITY.NONE
}

/**
 * 一条经验的完整画像（区分的结果）。
 *
 * `signatureFits` 只说明**正则能否编译**，不说明它是否匹配当前上下文——
 * 后者要 `matchSignature` 拿实际文本去跑。
 */
export function classify(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const support = supportOf(entry)
  const role = roleOf(entry)
  const confirmability = confirmabilityOf(entry)
  const sourcePattern = typeof entry.prescan_pattern === 'string' ? entry.prescan_pattern : undefined
  let signatureCompiles = false
  let signatureBroken = false
  if (confirmability === CONFIRMABILITY.SIGNATURE && sourcePattern !== undefined) {
    /**
     * 双转义 = 数据写坏了。`p\s*` 在 JSON 里多转义了一层：编译能过，
     * 但它匹配的是**字面反斜杠**，对任何正常文本都不成立。
     * 实测 22 条非空正则里 4 条如此——"能编译"绝不能当成"可用"。
     * 如实标出来，由调用方决定修数据还是忽略；本层不去反解猜测作者意图。
     */
    // 检测的是**两个连续反斜杠**（源码里写四个），不是任意反斜杠：
    // 正常正则里全是单个反斜杠（`\s`、`\.`），拿单反斜杠当判据会把它们全误判。
    signatureBroken = sourcePattern.includes('\\\\')
    try {
      new RegExp(sourcePattern)
      signatureCompiles = !signatureBroken
    } catch {
      signatureCompiles = false
      signatureBroken = true
    }
  }
  return {
    id: String(entry.id ?? ''),
    title: typeof entry.title === 'string' ? entry.title : '',
    role,
    support,
    confirmability,
    signatureCompiles,
    signatureBroken,
    // 原始正则要带出来：matchSignature 只能用它跑上下文，不能自己再猜一遍。
    sourcePattern,
    stage: typeof entry.stage === 'string' ? entry.stage : undefined,
    severity: typeof entry.severity === 'string' ? entry.severity : undefined,
    // 进入上下文的正文：优先给可执行的做法，没有才退回背景说明。
    body:
      (typeof entry.rec_approach === 'string' && entry.rec_approach) ||
      (typeof entry.root_cause === 'string' && entry.root_cause) ||
      (typeof entry.title === 'string' && entry.title) ||
      '',
    forbid: Array.isArray(entry.forbid) ? entry.forbid.filter((item) => typeof item === 'string' && item !== '') : [],
  }
}

/**
 * 形式化确认：拿经验自带的正则去跑当前上下文正文。
 *
 * 这是本层唯一"硬"的确认手段——不是相似度、不是模型判断，是正则匹配，
 * 结果可复现。匹配上说明**这个失败模式在当前材料里确实出现了**。
 *
 * 返回命中的片段（截断）便于在报告里展示"依据是什么"。
 */
export function matchSignature(picture, text) {
  if (picture === null || picture.signatureCompiles !== true) return undefined
  if (typeof text !== 'string' || text === '') return undefined
  let pattern
  try {
    pattern = new RegExp(picture.sourcePattern ?? '', 'm')
  } catch {
    return undefined
  }
  const hit = pattern.exec(text)
  if (hit === null) return undefined
  return { match: hit[0].slice(0, 80), index: hit.index }
}

/**
 * 把证据账本压成一段可做正则匹配的正文。
 *
 * 为什么需要它：形式化确认要拿"当前材料"去跑签名，而当前材料就是本项目已经
 * 落进来的证据（结论、指标、失败事实）。没有这段正文，19 条可用签名一条也
 * 匹配不上，"确认"就永远走不到。
 *
 * 防御式遍历：账本形状随图与版本会变，这里只收集字符串与数字，深度与总量都有
 * 上限——这是给正则用的材料，不是要索引全文。
 */
export function contextFromEvidence(evidence, extra = '') {
  const parts = []
  const MAX_CHARS = 20000
  let chars = 0
  const walk = (value, depth) => {
    if (chars >= MAX_CHARS || depth > 6) return
    if (typeof value === 'string') {
      if (value !== '') {
        parts.push(value)
        chars += value.length
      }
      return
    }
    if (typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item, depth + 1)
    }
  }
  walk(evidence, 0)
  if (typeof extra === 'string' && extra !== '') parts.push(extra)
  return parts.join(' ').slice(0, MAX_CHARS)
}

/**
 * 决定准入。
 *
 * 判据（按优先级）：
 *   1. 该条目的正则匹配当前上下文 → **直接准入**，理由 `confirmed_by_signature`。
 *      这是最强理由：问题被实际检出，不是猜的。
 *   2. 有验证命令 → 准入，理由 `has_verification_command`（可复核）。
 *   3. 有外部引文 / 有来源事件 → 准入，理由对应。
 *   4. 只有声明（`bare`）→ **不进**，除非 1 成立。这是本层的核心取舍：
 *      库里 76% 的条目属于这一级，让它们凭 BM25 分数进请求，就是污染。
 *
 * `floor` 允许调用方放宽到 `bare`（例如做全库盘点），但默认不放宽。
 * 淘汰理由用常量，便于统计与测试。
 */
export function admit(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const floor = options.floor ?? SUPPORT.SOURCED
  const stage = typeof options.stage === 'string' ? options.stage : undefined
  const context = typeof options.context === 'string' ? options.context : ''
  const budget = Number.isFinite(options.budget) ? options.budget : 4000

  const admitted = []
  const rejected = []
  const seen = new Set()
  let used = 0

  for (const raw of list) {
    const picture = classify(raw)
    if (picture === null || picture.id === '') {
      rejected.push({ id: null, reason: EXCLUSION.INVALID })
      continue
    }
    // 同一条经验只进一次：检索可能因多字段命中而重复返回。
    if (seen.has(picture.id)) continue
    seen.add(picture.id)
    /**
     * 有验证命令的条目可以越过支撑门槛。
     *
     * 理由：支撑门槛问的是"凭什么信它"，而**可复核本身就是一种凭据**——
     * 调用方跑一下命令就知道真假，这比一条没有引文的断言强。
     * 实测踩过：一条带 `verification_cmd` 的流程因为没挂引文被误拒。
     */
    const checkable = picture.confirmability === CONFIRMABILITY.COMMAND

    const signature = matchSignature(picture, context)
    if (signature !== undefined) {
      // 最强理由：正则真的匹配了当前材料。
      admitted.push({
        ...picture,
        confirmedBy: ADMISSION.CONFIRMED,
        evidence: signature,
        reason: ADMISSION.CONFIRMED,
        stageFit: stageOf(picture.stage, stage),
      })
      used += picture.body.length
      continue
    }

    // 支撑等级不足、又不可复核、也未被形式化确认 → 拒绝，并如实写明理由。
    if (!checkable && SUPPORT_RANK[picture.support] < SUPPORT_RANK[floor]) {
      rejected.push({ id: picture.id, title: picture.title, support: picture.support, role: picture.role, reason: EXCLUSION.FLOOR })
      continue
    }

    /**
     * 阶段只标注、不淘汰。
     *
     * 测量依据见文件头：`stage` 有 94% 是没填的默认值（训练内容的条目
     * 172/182 被标成 conception）。拿它做门禁等于随机淘汰。
     */
    const stageFit = stageOf(picture.stage, stage)

    const reason =
      picture.confirmability === CONFIRMABILITY.COMMAND
        ? ADMISSION.VERIFIED
        : picture.support === SUPPORT.CITED
          ? ADMISSION.CITED
          : ADMISSION.SOURCED

    // 预算：超了就淘汰并记账，绝不静默截断——截断会让"为什么少了"无从解释。
    if (used + picture.body.length > budget) {
      rejected.push({ id: picture.id, title: picture.title, support: picture.support, role: picture.role, reason: EXCLUSION.BUDGET })
      continue
    }
    used += picture.body.length
    admitted.push({ ...picture, confirmedBy: undefined, reason, stageFit })
  }

  /**
   * 排序：先按角色重要性，再按支撑等级，最后按 id。
   *
   * 失败模式必须排前面——它会让本轮工作出错，比可选的流程更该被先读到。
   * 用固定序保证两次调用顺序一致（可 diff）。
   */
  const ROLE_RANK = { hazard: 4, principle: 3, procedure: 2, guidance: 1 }
  /** stageFit 只影响排序：标注对得上的先读。 */
  const STAGE_RANK = { exact: 2, unset: 1, mismatch: 0 }
  admitted.sort(
    (left, right) =>
      // 全部按**降序**：rank 大者在前。写反了会让"失败模式先读"变成"最后读"。
      (ROLE_RANK[right.role] ?? 0) - (ROLE_RANK[left.role] ?? 0) ||
      SUPPORT_RANK[right.support] - SUPPORT_RANK[left.support] ||
      (STAGE_RANK[right.stageFit] ?? 0) - (STAGE_RANK[left.stageFit] ?? 0) ||
      left.id.localeCompare(right.id),
  )

  return {
    admitted,
    rejected,
    used,
    budget,
    // 汇总：调用方与 UI 都读这一份，避免两处算法。
    counts: {
      candidates: seen.size,
      admitted: admitted.length,
      rejected: rejected.length,
      confirmed: admitted.filter((item) => item.confirmedBy === ADMISSION.CONFIRMED).length,
      byRole: countBy(admitted, 'role'),
      bySupport: countBy(admitted, 'support'),
      excludedBy: countBy(rejected, 'reason'),
    },
    floor,
    // 一句话解释：为什么进这些、为什么没进那些。空数组也要说明。
    summary: summarize(admitted, rejected, used, budget, floor),
  }
}

/**
 * 给工具结果用的紧凑形式。
 *
 * 完整报告带着每条正文，直接回给模型会把工具结果撑成一份文档；而模型需要的是
 * "哪几条进了、凭什么"。正文由面板按 id 展开。
 */
export function compactAdmission(admission) {
  if (admission === null || typeof admission !== 'object') return null
  return {
    summary: admission.summary,
    counts: admission.counts,
    used: admission.used,
    budget: admission.budget,
    admitted: admission.admitted.map((item) => ({
      id: item.id,
      title: item.title,
      role: item.role,
      support: item.support,
      reason: item.reason,
      stageFit: item.stageFit,
      confirmed: item.confirmedBy === ADMISSION.CONFIRMED,
      evidence: item.evidence?.match,
    })),
    rejected: admission.rejected.slice(0, 20).map((item) => ({ id: item.id, reason: item.reason })),
  }
}

function countBy(list, key) {
  const result = {}
  for (const item of list) {
    const value = item[key]
    if (typeof value !== 'string') continue
    result[value] = (result[value] ?? 0) + 1
  }
  return result
}

/** 把准入结果压成可以贴进提示词/面板的一句话。 */
function summarize(admitted, rejected, used, budget, floor) {
  if (admitted.length === 0 && rejected.length === 0) return '本轮没有候选经验。'
  const parts = [`准入 ${admitted.length} 条（${used}/${budget} 字），淘汰 ${rejected.length} 条`]
  const confirmed = admitted.filter((item) => item.confirmedBy === ADMISSION.CONFIRMED).length
  if (confirmed > 0) parts.push(`其中 ${confirmed} 条由上下文正则确认`)
  const byReason = countBy(rejected, 'reason')
  const labels = {
    [EXCLUSION.FLOOR]: '支撑不足',
    [EXCLUSION.BUDGET]: '超预算',
    [EXCLUSION.INVALID]: '条目无效',
  }
  const excluded = Object.entries(byReason)
    .map(([reason, count]) => `${labels[reason] ?? reason} ${count}`)
    .join('、')
  if (excluded !== '') parts.push(`淘汰原因：${excluded}`)
  if (floor === SUPPORT.BARE) parts.push('（本次已放宽到无支撑条目）')
  return parts.join('；') + '。'
}

/**
 * 渲染成给模型读的正文。
 *
 * 每条都带理由：模型看到的不只是"该做什么"，还有"为什么这条被放进来"——
 * 这样它才知道该多信一分还是留一分怀疑。无确认依据的条目明写"未经确认"。
 */
export function renderAdmission(admission) {
  if (admission === null || typeof admission !== 'object') return ''
  const lines = []
  if (admission.admitted.length === 0) return ''
  for (const item of admission.admitted) {
    const tag = reasonLabel(item.reason)
    lines.push(`- [${item.role}/${item.support}] ${item.id} ${item.title}（${tag}）`)
    if (item.confirmedBy === ADMISSION.CONFIRMED && item.evidence !== undefined) {
      lines.push(`  上下文命中：\`${item.evidence.match}\``)
    }
    if (item.body !== '') {
      // 正文压到 240 字：准入层给的是"该做什么"，全文由模型按 id 自行展开。
      lines.push(`  ${item.body.length > 240 ? `${item.body.slice(0, 240)}…` : item.body}`)
    }
    if (item.forbid.length > 0) {
      lines.push(`  禁止：${item.forbid.join('；')}`)
    }
  }
  lines.push(admission.summary)
  return lines.join('\n')
}

/** 理由 → 中文标签。未知理由不隐藏，原样显示，便于发现新增的未翻译理由。 */
export function reasonLabel(reason) {
  const labels = {
    [ADMISSION.CONFIRMED]: '上下文确认',
    [ADMISSION.VERIFIED]: '有验证命令，可复核',
    [ADMISSION.CITED]: '有引文',
    [ADMISSION.SOURCED]: '有来源事件',
    [EXCLUSION.FLOOR]: '支撑不足',
    [EXCLUSION.BUDGET]: '超预算',
    [EXCLUSION.INVALID]: '条目无效',
  }
  return labels[reason] ?? String(reason)
}
