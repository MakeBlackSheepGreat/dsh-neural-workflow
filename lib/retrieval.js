/**
 * 内置检索（host 平面，纯函数）：分词 + BM25 + 片段抽取。
 *
 * 这一层替代了原来的"线性词项加权"，因为原实现有三个实测缺陷：
 *
 *   ① **正文从未参与索引**。旧实现只索引标题与触发词，611 条正文的 13.8 万字
 *      一个字都没进索引。所以 `loss 不下降`、`评审说无法复现` 这种
 *      "症状在正文里、标题里没有"的查询必然查不到。
 *   ② **没有长度归一化**。长标题命中一个词就压过短标题命中三个词，
 *      这是打分不是检索。
 *   ③ **只返回 id**。调用方拿到 id 还得再查一次才有正文，那不是 RAG。
 *
 * 分词为什么用 bigram 而不是词典：这 611 条是神经网论文的领域文本，
 * "梯度检查点""数据泄漏""多比较膨胀"这类词通用词典会切错，而领域词典
 * 需要维护、会过期。中文 bigram + 英文词零依赖、对领域词更稳——代价是
 * 索引变大，611 条这个量级完全承受得住。
 */

import { KB_ENTRIES } from './kb-data.js'
import { KB_FULL } from './kb-full.js'

/** BM25 参数。k1 控制词频饱和，b 控制长度归一化强度；这两个值是标准默认。 */
const K1 = 1.2
const B = 0.75

/**
 * 字段权重。
 *
 * 标题命中最强（它就是这条经验的断言），触发词次之（作者手写的症状），
 * 正文最弱但**不为零**——这是修掉缺陷①的关键。权重比例是经验值：
 * 标题比正文重 3 倍，足以让精确标题命中排前面，又不至于让正文命中完全失效。
 */
const FIELDS = [
  { name: 'title', weight: 3 },
  { name: 'triggers', weight: 2 },
  { name: 'body', weight: 1 },
]

/**
 * 分词：中文 bigram + 英文/数字词。
 *
 * 单字刻意不收：`的`、`不`、`是` 会把无关条目连起来，让"不下降"匹配到
 * 任何含"不"的正文。英文按长度 ≥2 切，`c++`、`3dgs` 这类带符号的也能留。
 */
export function tokenize(text) {
  const raw = typeof text === 'string' ? text.toLowerCase() : ''
  const tokens = []
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  for (const word of raw.match(/[a-z][a-z0-9_#.+-]{1,}/g) ?? []) tokens.push(word)
  return tokens
}

/** 把一条全文对象拍平成一段可检索的正文。数组用空格连接，非字符串忽略。 */
export function bodyOf(fullEntry) {
  if (fullEntry === null || typeof fullEntry !== 'object') return ''
  const parts = []
  for (const value of Object.values(fullEntry)) {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) parts.push(value.filter((item) => typeof item === 'string').join(' '))
  }
  return parts.join(' ')
}

/** 词频表。 */
function termFrequency(tokens) {
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  return tf
}

/**
 * 疑问词与口语填充词。
 *
 * 为什么必须在**查询侧**剥掉：中文 bigram 会把「怎么做消融」切成
 * 「怎么/么做/做消/消融」，其中「做消」跨了词边界，在库里极罕见，
 * 于是「怎么做消融」反而搜不到「消融组同时开关多模块」这条最该命中的经验
 * （实测 NP011 掉出前五）。剥掉问句外壳后，剩下的「消融」直接命中。
 *
 * 只剥这些**不含领域信息**的词；「为什么」保留语义但也不含领域词，
 * 所以一并剥掉——它问的是原因，而原因在命中条目的正文里。
 */
const QUESTION_WORDS = [
  '怎么办', '怎么做', '怎么', '如何', '为什么', '为何', '什么', '哪些', '哪个',
  '是不是', '能不能', '可不可以', '有没有', '该不该', '要不要',
  '请问', '请教', '帮我', '帮忙', '告诉我',
  '时候', '的话', '了吗', '呢', '吗', '吧', '啊',
]

/** 查询预处理：剥掉问句外壳与标点，保留领域词。 */
export function normalizeQuery(query) {
  let text = typeof query === 'string' ? query : ''
  // 标点当分隔符，别让它们参与 bigram 的形成（否则会切出跨标点的垃圾片段）。
  text = text.replace(/[\s，。！？、；：,.!?;:'"()（）\[\]【】<>《》|/\-]+/g, ' ')
  for (const word of QUESTION_WORDS) text = text.split(word).join(' ')
  return text.replace(/\s+/g, ' ').trim()
}

let cached = null

/**
 * 建索引。611 条规模下这一步几十毫秒，之后整个进程复用。
 *
 * 索引里同时留 `tf`（打分用）与 `length`（归一化用）。不留原始 token 数组：
 * 611 条 × 3 字段的 token 列表占内存且没人再用。
 */
function buildIndex() {
  if (cached !== null) return cached

  const docs = KB_ENTRIES.map((entry) => {
    const full = KB_FULL[entry.i]
    const fieldTokens = {
      title: tokenize(entry.t),
      triggers: tokenize(String(entry.q ?? '').replace(/\|/g, ' ')),
      body: tokenize(bodyOf(full)),
    }
    const fields = {}
    for (const { name } of FIELDS) {
      fields[name] = { tf: termFrequency(fieldTokens[name]), length: fieldTokens[name].length }
    }
    return {
      id: entry.i,
      title: entry.t,
      category: entry.c,
      ktype: entry.k,
      severity: entry.s,
      stage: entry.st,
      fields,
      // 预存一段摘要，避免检索时再从全文里现拼。
      gist: gistOf(full, entry),
    }
  })

  // 每个字段各自的 df 与平均长度：不同字段的词表与长度分布差得很远，
  // 混在一起算 idf 会让正文的高频词污染标题的 idf。
  const fieldStats = {}
  for (const { name } of FIELDS) {
    const df = new Map()
    let totalLength = 0
    for (const doc of docs) {
      const { tf, length } = doc.fields[name]
      totalLength += length
      for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    }
    fieldStats[name] = { df, avgLength: totalLength / Math.max(1, docs.length) }
  }

  cached = { docs, fieldStats, total: docs.length }
  return cached
}

/** 摘要：优先 rootCause（那条经验的"为什么"），没有就退回 approach。 */
function gistOf(full, entry) {
  if (full === null || typeof full !== 'object') return ''
  for (const key of ['rootCause', 'approach', 'verify']) {
    const value = full[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim()
      return text.length > 180 ? `${text.slice(0, 180)}…` : text
    }
  }
  return ''
}

/**
 * 检索。返回带**分数与字段命中明细**的结果，不是一个光秃秃的 id 列表。
 *
 * `matched` 记录哪些词在哪个字段命中——面板用它高亮，模型用它判断
 * "为什么这条被选中"。没有命中明细的检索结果无法被质疑，也无法被调优。
 */
export function search(query, limit = 8) {
  const { docs, fieldStats, total } = buildIndex()

  /**
   * 相关度门槛：按 **idf 加权**的查询覆盖率，而不是数命中词个数。
   *
   * 为什么不能用个数：`zzzzz不存在的词qqqqq` 被切成 6 个 bigram，
   * 其中「存在」命中了几条讲"存在性定理"的论文，按个数算是 1/6 —— 低，
   * 但 BM25 的 idf 会因为「存在」在库里少见而给它不低的分数，于是返回一条噪声。
   *
   * 为什么也不能只用 idf 加权：中文 bigram 会跨越词边界产生垃圾片段。
   * `怎么做消融` 切成「怎么/么做/做消/消融」，其中「做消」在库里极罕见，
   * idf 很高，反而把真正有信息量的「消融」压成少数派 —— 正确结果被门槛误杀。
   *
   * 真正的判据是**命中是否连续**：一个查询只要有一段足够长的连续 bigram
   * 命中同一条目，就是真命中；零散命中单个 bigram 就是噪声。
   * 所以门槛查的是"最长连续命中串覆盖了查询的多少比例"。
   */
  const minCoverage = 0.3

  /**
   * 查询侧按原顺序保留 token，并记住它属于哪个"串"以及串内位置。
   * "连续"只在同一个串内成立：汉字串按 bigram 滑窗，英文词各自成一个串
   * （英文词本来就是完整语义单位，不需要再切）。
   *
   * 这里必须把英文词也算进来——只收汉字串的话，`AUC=1.0` 会一个 token 都没有，
   * 于是正确的检索结果被自己的门槛杀掉。
   */
  const orderedTokens = []
  const lowered = normalizeQuery(query).toLowerCase()
  for (const run of lowered.match(/[一-鿿]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      orderedTokens.push({ token: run.slice(index, index + 2), run: `cjk:${run}`, position: index })
    }
  }
  for (const word of lowered.match(/[a-z][a-z0-9_#.+-]{1,}/g) ?? []) {
    orderedTokens.push({ token: word, run: `word:${word}`, position: 0 })
  }
  const queryTokens = [...new Set(orderedTokens.map((item) => item.token))]
  if (queryTokens.length === 0) return []

  // 每个查询词的 idf 权重，作为覆盖率的分母。
  const queryWeights = new Map()
  let weightTotal = 0
  for (const token of queryTokens) {
    let documentFrequency = 0
    for (const { name } of FIELDS) {
      const seen = fieldStats[name].df.get(token) ?? 0
      if (seen > documentFrequency) documentFrequency = seen
    }
    const weight = Math.log(1 + (total + 0.5) / (documentFrequency + 0.5))
    queryWeights.set(token, weight)
    weightTotal += weight
  }
  const scored = []
  for (const doc of docs) {
    let score = 0
    const matched = []
    for (const { name, weight } of FIELDS) {
      const { tf, length } = doc.fields[name]
      const { df, avgLength } = fieldStats[name]
      for (const token of queryTokens) {
        const frequency = tf.get(token)
        if (frequency === undefined) continue
        const documentFrequency = df.get(token) ?? 0
        // BM25 的 idf：出现越少越有信息量。+0.5 平滑避免负值。
        const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
        const denominator = frequency + K1 * (1 - B + (B * length) / (avgLength || 1))
        score += weight * idf * ((frequency * (K1 + 1)) / denominator)
        matched.push({ token, field: name })
      }
    }
    if (score <= 0) continue
    /**
     * 覆盖率 = 最长连续命中串的长度 / 查询 token 总数。
     *
     * "连续"只在同一个串内成立：汉字串里相邻的 bigram 一起命中才算数，
     * 这挡住了「做消」这类跨词边界的孤命中；英文词各自成串，命中一个算一个。
     * 单个英文词命中时覆盖率可能偏低，但英文词通常只有 1-2 个，
     * 分母也小，不会被误杀。
     */
    const hitTokens = new Set(matched.map((item) => item.token))
    let bestRun = 0
    for (const run of new Set(orderedTokens.map((item) => item.run))) {
      const items = orderedTokens.filter((item) => item.run === run)
      let current = 0
      for (const item of items) {
        if (hitTokens.has(item.token)) {
          current += 1
          if (current > bestRun) bestRun = current
        } else {
          current = 0
        }
      }
    }
    /**
     * 通过条件（两者之一）：
     *   ① 最长连续命中串覆盖查询的 minCoverage 以上——长查询靠这个，
     *      「做消」这类跨词边界的孤命中过不了。
     *   ② 查询本身很短（≤2 个 token），命中其中任意一个即可——
     *      `AUC=1.0`、`显存不足` 这种就是一个词，要求比例没有意义。
     *
     * 两条合起来才既不误杀短查询，也不放过长查询里的散命中。
     */
    const tokenCount = orderedTokens.length
    const coverage = tokenCount === 0 ? 0 : bestRun / tokenCount
    const passes = tokenCount <= 2 ? bestRun >= 1 : coverage >= minCoverage
    if (!passes) continue

    scored.push({ ...doc, score: Math.round(score * 100) / 100, coverage: Math.round(coverage * 100) / 100, matched })
  }

  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return scored.slice(0, Math.max(1, limit)).map((doc) => ({
    id: doc.id,
    title: doc.title,
    category: doc.category,
    ktype: doc.ktype,
    severity: doc.severity,
    stage: doc.stage,
    score: doc.score,
    coverage: doc.coverage,
    gist: doc.gist,
    matched: doc.matched.slice(0, 8),
  }))
}

/**
 * RAG：检索 + 组装成可直接塞进上下文的片段。
 *
 * 与 `search` 的区别是它**带正文**。这才是"检索增强生成"：
 * 调用方不必再逐条取全文，一次就拿到能读的东西。
 *
 * `budget` 是字符上限（不是 token）：这里不该假装知道调用方的 tokenizer，
 * 给一个字符预算，由调用方按自己的口径折算。超出时按分数从高到低装，
 * 装不下就停——宁可少给两条，也不截断到半句。
 */
export function retrieve(query, { limit = 4, budget = 4000 } = {}) {
  const matches = search(query, Math.max(limit, 1) * 3)
  const passages = []
  let used = 0
  for (const match of matches) {
    if (passages.length >= limit) break
    const full = KB_FULL[match.id] ?? {}
    const body = bodyOf(full)
    const room = budget - used
    if (room <= 0) break
    // 截断时省略号**也算进预算**：否则 slice(0, room) 再加一个 `…`
    // 就变成 room+1 字符，实际用量悄悄超出调用方给的预算（实测超 1 个字符）。
    const text = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body
    passages.push({ id: match.id, title: match.title, score: match.score, gist: match.gist, text, truncated: body.length > room })
    used += text.length
  }
  return { query, passages, used, budget }
}

/** 统计：面板顶部显示总数与分布。 */
export function stats() {
  const { docs } = buildIndex()
  const byKind = {}
  const byCategory = {}
  for (const doc of docs) {
    byKind[doc.ktype] = (byKind[doc.ktype] ?? 0) + 1
    byCategory[doc.category] = (byCategory[doc.category] ?? 0) + 1
  }
  return { total: docs.length, byKind, byCategory }
}

/** 测试用：允许重建索引（改了数据或参数后）。 */
export function resetIndexCache() {
  cached = null
}
