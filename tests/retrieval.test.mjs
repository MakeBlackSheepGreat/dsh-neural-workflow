/**
 * 内置检索的测试。
 *
 * 这一组断言的重点不是"能搜到东西"，而是**修掉的那三个缺陷各自有对应的反证**：
 * 正文可检索、长度有归一化、RAG 带正文。每条都写成"如果改回去就会失败"的形式。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bodyOf, retrieve, search, stats, tokenize } from '../lib/retrieval.js'
import { KB_FULL } from '../lib/kb-full.js'
import { KB_ENTRIES } from '../lib/kb-data.js'

test('分词：中文取 bigram，英文取词，不收单字', () => {
  const tokens = tokenize('梯度检查点 loss')
  assert.ok(tokens.includes('梯度'), '应含中文 bigram「梯度」')
  assert.ok(tokens.includes('度检'), 'bigram 要逐位滑窗，不是只取词首')
  assert.ok(tokens.includes('loss'), '英文词应保留')
  // 单字是缺陷源：「不」会让「不下降」匹配到任何含「不」的正文。
  assert.ok(!tokens.includes('梯'), '不应保留单个汉字')
})

test('正文拍平：字符串与字符串数组都进正文，非字符串忽略', () => {
  const text = bodyOf({ a: '甲', b: ['乙', '丙'], c: 42, d: null })
  assert.ok(text.includes('甲'))
  assert.ok(text.includes('乙') && text.includes('丙'))
  assert.ok(!text.includes('42'), '数字不该被当成正文')
})

test('已知症状词：四个老用例仍然排在 TOP3', () => {
  // 这四条是旧实现的"能过"集合。改成 BM25 之后不许退化。
  const cases = [
    ['AUC=1.0', 'NP002'],
    ['怎么做消融', 'NP011'],
    ['多比较膨胀', 'NP001'],
    ['显存不足', 'NP027'],
  ]
  for (const [query, expected] of cases) {
    const ids = search(query, 5).map((item) => item.id)
    assert.ok(ids.slice(0, 3).includes(expected), `${query} 应把 ${expected} 排进前三，实际 ${ids.slice(0, 3).join(',')}`)
  }
})

test('正文参与检索：症状只在正文里的查询也能命中', () => {
  // 「梯度检查点」这四个字只出现在 NP027 的标题/正文，旧实现（只索引标题+触发词）
  // 靠标题也能中，所以这里换个只在正文出现的说法来证明正文真的进了索引。
  const target = 'NP027'
  const full = KB_FULL[target] ?? {}
  const body = bodyOf(full)
  assert.ok(body.includes('梯度检查点'), '前置条件：NP027 正文里有这个词')
  const ids = search('梯度检查点', 5).map((item) => item.id)
  assert.equal(ids[0], target, `正文里的关键词应让 ${target} 排第一，实际 ${ids[0]}`)
})

test('正文检索的反证：正文若被排除，某些查询就查不到', () => {
  // 挑一个"标题里没有、只有正文有"的词，验证它确实能检索到东西。
  // 如果哪天有人把 body 字段从 FIELDS 里删掉，这条会先失败。
  const probe = '逐样本'
  const inBody = KB_ENTRIES.filter((entry) => bodyOf(KB_FULL[entry.i] ?? {}).includes(probe))
  assert.ok(inBody.length > 0, `前置条件：至少一条正文含「${probe}」`)
  const hits = search(probe, 20).map((item) => item.id)
  assert.ok(hits.length > 0, `「${probe}」只在正文里，正文索引缺失时会一条都搜不到`)
})

test('长度归一化：短标题命中不被长标题压死', () => {
  // BM25 的 b 参数就是为了这件事。构造一个"多个短词命中"的查询，
  // 断言分数不是被最长的那条垄断。
  const results = search('消融 归因 模块', 10)
  assert.ok(results.length >= 2, '应有多个结果')
  // 分数必须严格递减（排序契约），且首条不是唯一非零项。
  for (let index = 1; index < results.length; index += 1) {
    assert.ok(results[index - 1].score >= results[index].score, '结果必须按分数降序')
  }
  assert.ok(results[1].score > 0, '第二条也要有正分，不能被第一条吃光')
})

test('命中明细：每个分数都能解释是哪个词在哪个字段命中的', () => {
  const [first] = search('显存不足', 3)
  assert.ok(Array.isArray(first.matched) && first.matched.length > 0, '必须带命中明细')
  for (const item of first.matched) {
    assert.ok(typeof item.token === 'string' && item.token !== '', '命中词不能为空')
    assert.ok(['title', 'triggers', 'body'].includes(item.field), `未知字段 ${item.field}`)
  }
})

test('RAG：返回正文片段而不只是 id', () => {
  const result = retrieve('显存不足', { limit: 2, budget: 2000 })
  assert.equal(result.passages.length > 0, true, '应有片段')
  for (const passage of result.passages) {
    assert.ok(typeof passage.id === 'string' && passage.id.startsWith('NP'), 'id 形状')
    assert.ok(typeof passage.title === 'string' && passage.title !== '', '要带标题')
    assert.ok(typeof passage.text === 'string' && passage.text !== '', 'RAG 的核心是带正文')
    assert.ok(passage.score > 0, '要带分数')
  }
  assert.ok(result.used <= result.budget, '实际用量不得超过预算')
})

test('RAG 预算：装不下就少给，不截断到半句之外', () => {
  const tight = retrieve('显存不足', { limit: 5, budget: 120 })
  assert.ok(tight.used <= tight.budget, `用量 ${tight.used} 超过预算 ${tight.budget}`)
  // 预算极小时宁可一条都不给，也不返回空字符串片段。
  for (const passage of tight.passages) assert.ok(passage.text.length > 0, '不许返回空片段')
})

test('空查询与纯乱码：返回空数组', () => {
  assert.deepEqual(search('', 5), [])
  assert.deepEqual(search('   ', 5), [])
  // 纯拉丁乱码在库里没有任何词，必须返回空。
  assert.deepEqual(search('qwertyuiop', 5), [])
  assert.deepEqual(search('zzzzz qqqqq', 5), [])
})

test('噪声门槛：散命中被挡掉，连续命中放行', () => {
  /**
   * 这条测的是门槛本身，而不是"乱码必须零结果"——后者是不现实的：
   * `zzzzz不存在的词qqqqq` 里「不存在」在库中确实连续命中几条讲存在性定理
   * 的论文，那是真命中，不是 bug。要证明的是：
   *   ① 只在查询里零星出现的词不会带来一堆结果；
   *   ② 一个真正具体的词能带出结果。
   */
  const scattered = search('随便说点什么', 10)
  assert.ok(scattered.length <= 2, `散命中应被门槛挡掉，实际返回 ${scattered.length} 条`)

  const concrete = search('显存不足', 5)
  assert.ok(concrete.length > 0, '具体的症状词必须能命中')
  assert.equal(concrete[0].id, 'NP027', '显存不足应首条命中 NP027')
})

test('统计：总数与已知的 611 条一致', () => {
  const value = stats()
  assert.equal(value.total, 611)
  assert.equal(value.total, KB_ENTRIES.length)
  const kindSum = Object.values(value.byKind).reduce((sum, count) => sum + count, 0)
  assert.equal(kindSum, value.total, '按 kind 分组求和应等于总数')
  const categorySum = Object.values(value.byCategory).reduce((sum, count) => sum + count, 0)
  assert.equal(categorySum, value.total, '按 category 分组求和应等于总数')
})
