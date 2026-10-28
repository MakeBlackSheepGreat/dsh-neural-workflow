/**
 * 知识库检索（host 平面，纯函数）。
 *
 * 源是 `skills/neural-paper-workflow/knowledge/graph` 的 611 条条目，构建期折成
 * `kb-data.js`（索引）与 `kb-full.js`（全文）。这里只做两件事：
 *
 *   ① **检索**：按查询词的命中强度给条目打分，返回前 N 条的索引行。
 *   ② **取全文**：命中的条目按 id 取，一次只给真正要用的那几条。
 *
 * 为什么不用正则去跑 `error_signature`：那 611 条里有大量手写正则，直接跑既慢又会
 * 因为一条坏正则整批失败。这里改成**词项命中**（分词后逐词计分），
 * 坏正则最多让一个条目少得分，不会让整个检索挂掉。
 */

import { KB_ENTRIES } from './kb-data.js'
import { KB_FULL } from './kb-full.js'

/** 中文没有空格，按"字 + 二元组"切；英文/数字按词切。 */
function tokenize(text) {
  const raw = typeof text === 'string' ? text.toLowerCase() : ''
  const tokens = new Set()
  for (const word of raw.match(/[a-z0-9_#.-]{2,}/g) ?? []) tokens.add(word)
  const cjk = raw.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.add(run[index])
      if (index + 1 < run.length) tokens.add(run.slice(index, index + 2))
    }
  }
  return tokens
}

/** 预计算：每条索引行的检索词项集合与长度，避免每次查询重算。 */
const PREPARED = KB_ENTRIES.map((entry) => ({
  entry,
  tokens: tokenize(`${entry.q} ${entry.t}`),
  titleTokens: tokenize(entry.t),
  lowerTitle: entry.t.toLowerCase(),
}))

/** 严重度权重：critical 的教训比 idea 更该先被看到。 */
const SEVERITY_WEIGHT = { critical: 3, major: 2, minor: 1 }

/**
 * 检索。返回 `[{ id, title, category, ktype, severity, stage, score }]`。
 *
 * 打分刻意简单（可解释、可复现）：标题命中比正文命中重，critical 加权。
 * 分数为 0 的条目直接丢弃——匹配不到就是匹配不到，不返回"看起来相关"的噪声。
 */
export function search(query, limit = 6) {
  const terms = tokenize(query)
  if (terms.size === 0) return []
  const scored = []
  for (const prepared of PREPARED) {
    let score = 0
    for (const term of terms) {
      if (prepared.titleTokens.has(term)) score += 3
      else if (prepared.tokens.has(term)) score += 1
      // 完整短语出现在标题里，额外加权（"多比较膨胀"这种整词命中）
      if (term.length >= 2 && prepared.lowerTitle.includes(term)) score += 2
    }
    if (score <= 0) continue
    score *= SEVERITY_WEIGHT[prepared.entry.s] ?? 1
    scored.push({
      id: prepared.entry.i,
      title: prepared.entry.t,
      category: prepared.entry.c,
      ktype: prepared.entry.k,
      severity: prepared.entry.s,
      stage: prepared.entry.st,
      score,
    })
  }
  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return scored.slice(0, Math.max(1, limit))
}

/** 按 id 取全文；未知 id 返回 undefined（调用方负责报错，不猜）。 */
export function full(id) {
  return KB_FULL[id]
}

/** 按 id 取索引行。 */
export function entry(id) {
  return KB_ENTRIES.find((item) => item.i === id)
}

/** 统计：给面板顶部显示"知识库有多少条"。 */
export function stats() {
  const byKind = {}
  for (const item of KB_ENTRIES) byKind[item.k] = (byKind[item.k] ?? 0) + 1
  return { total: KB_ENTRIES.length, byKind }
}

export const KB_TOTAL = KB_ENTRIES.length
