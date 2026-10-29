/**
 * 经验库的**图**（host 平面，纯函数）。
 *
 * 为什么要有它：611 条条目藏在搜索框后面是错的——**结构本身就是信息**。
 * 面板要画的是"类别是枢纽、条目挂在类别下、条目之间按语义相近连线"的蛛网，
 * 而不是让用户先想出一个症状词。
 *
 * 连接怎么算（这里的选择必须可解释，否则图就是装饰）：
 *   ① 用中文字符二元组（bigram）+ 英文词做特征，不用单字——单字把"学习/学生"
 *      这种无关项连起来。
 *   ② 只用**中频** bigram 当连接词：df < MIN_DF 的太少（只在一条里出现，连不出东西），
 *      df > MAX_DF 的太泛（"模型""数据"会把整张图连成毛球）。这是 tf-idf 的
 *      idf 那一步，只不过这里当成"哪些词配当边"的门槛。
 *   ③ idf 加权余弦，阈值 0.25。实测这组参数在 611 条上给出 1160 条边、
 *      平均度 3.8、最大连通分量 569/611——一张真有形状的网，不是硬凑的。
 *
 * 不预先算好存成文件：611² 的余弦对只要 18 万次比较，在宿主里一次性算完
 * 也就几十毫秒，而预生成一份边表会让"知识库更新了但边表没更新"成为可能。
 */

import { KB_ENTRIES } from './kb-data.js'

/** 中频连接词的 df 区间：低于下限连不出东西，高于上限会把图连成毛球。 */
const MIN_DF = 6
const MAX_DF = 120
/** 连边的相似度阈值。调高会碎成孤岛，调低会糊成一团。 */
const EDGE_THRESHOLD = 0.25

/** 特征：中文 bigram + 英文/数字词。单字刻意不要。 */
function features(text) {
  const raw = String(text).toLowerCase()
  const out = new Set()
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) out.add(run.slice(index, index + 2))
  }
  for (const word of raw.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) out.add(`w:${word}`)
  return out
}

/** 参与连线的文本：标题 + 检索串（触发词与症状签名都在 q 里）。 */
function textOf(entry) {
  return `${entry.t} ${String(entry.q ?? '').replace(/\|/g, ' ')}`
}

let cached = null

/**
 * 算一次整张图，之后复用。
 *
 * `categories` 是主节点（11 个），`entries` 是叶子节点（611 个），
 * `edges` 同时含"类别—条目"的归属边与"条目—条目"的相似边，
 * 用 `kind` 区分——前端据此画两种线宽，不需要再猜。
 */
export function graph() {
  if (cached !== null) return cached

  const total = KB_ENTRIES.length
  const docs = KB_ENTRIES.map((entry) => features(textOf(entry)))

  // 文档频率：决定哪些 bigram 配当连接词。
  const df = new Map()
  for (const set of docs) for (const gram of set) df.set(gram, (df.get(gram) ?? 0) + 1)
  const connectors = new Set()
  for (const [gram, count] of df) {
    if (count >= MIN_DF && count <= MAX_DF) connectors.add(gram)
  }

  // idf 加权向量：只保留连接词。
  const vectors = docs.map((set) => {
    const vector = new Map()
    for (const gram of set) {
      if (!connectors.has(gram)) continue
      vector.set(gram, Math.log(total / (1 + df.get(gram))))
    }
    return vector
  })

  const cosine = (left, right) => {
    let dot = 0
    let leftNorm = 0
    for (const [gram, weight] of left) {
      leftNorm += weight * weight
      const other = right.get(gram)
      if (other !== undefined) dot += weight * other
    }
    if (dot === 0) return 0
    let rightNorm = 0
    for (const weight of right.values()) rightNorm += weight * weight
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) + 1e-9)
  }

  const edges = []
  for (let i = 0; i < total; i += 1) {
    for (let j = i + 1; j < total; j += 1) {
      const score = cosine(vectors[i], vectors[j])
      if (score < EDGE_THRESHOLD) continue
      // 权重保留三位小数：前端只需要按强度调线宽，不需要全精度。
      edges.push([KB_ENTRIES[i].i, KB_ENTRIES[j].i, Math.round(score * 1000) / 1000])
    }
  }

  const degree = new Map()
  for (const [from, to] of edges) {
    degree.set(from, (degree.get(from) ?? 0) + 1)
    degree.set(to, (degree.get(to) ?? 0) + 1)
  }

  const byCategory = new Map()
  for (const entry of KB_ENTRIES) {
    const key = entry.c || 'other'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(entry.i)
  }

  const categories = [...byCategory.entries()]
    .map(([id, ids]) => ({
      id,
      count: ids.length,
      // 类别的"重要度"取它内部最大度数——类别是枢纽还是边角，由内容决定，
      // 不按条目数量排（idea 有 567 条但平均度只有 3.7，perf 只有 3 条却平均度 10）。
      weight: Math.max(0, ...ids.map((entryId) => degree.get(entryId) ?? 0)),
    }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))

  const entries = KB_ENTRIES.map((entry) => ({
    id: entry.i,
    title: entry.t,
    category: entry.c || 'other',
    ktype: entry.k,
    severity: entry.s,
    stage: entry.st,
    degree: degree.get(entry.i) ?? 0,
  }))

  cached = {
    categories,
    entries,
    edges,
    stats: {
      entries: entries.length,
      categories: categories.length,
      edges: edges.length,
      connectors: connectors.size,
      threshold: EDGE_THRESHOLD,
      // 孤立点数量是这张图"好不好看"的诚实指标：孤岛多说明阈值偏高。
      isolated: entries.filter((entry) => entry.degree === 0).length,
    },
  }
  return cached
}

/** 测试用：允许重新计算（生产路径不需要）。 */
export function resetGraphCache() {
  cached = null
}
