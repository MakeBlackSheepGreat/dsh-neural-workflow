#!/usr/bin/env node
/**
 * 把 skill 的知识图谱折成插件可检索的索引。
 *
 * 源：`skills/neural-paper-workflow/knowledge/graph/NP*.json`（614 条，含 idea/error/experiment…）
 * 产物：`lib/kb-data.js`（紧凑索引）+ `lib/kb-full.js`（按 id 取全文）
 *
 * 为什么要分两个文件：模型只需要**索引**做检索（标题/触发词/症状签名），
 * 全文只在命中之后按 id 取。学 clearAI 与 dsh-context 的渐进披露：
 * 一次把 611 条全文塞进上下文，等于把预算全烧在"可能会用到"的东西上。
 *
 * 用法：
 *   node scripts/build-kb.mjs            # 生成
 *   node scripts/build-kb.mjs --check    # 校验产物是否最新
 *   node scripts/build-kb.mjs --skill <dir>   # 指定 skill 根目录
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

/** skill 位置：显式参数 → 同仓 sibling → 环境变量。 */
function skillDir() {
  const flag = process.argv.indexOf('--skill')
  if (flag >= 0 && process.argv[flag + 1]) return resolve(process.argv[flag + 1])
  if (process.env.NEURAL_PAPER_SKILL) return resolve(process.env.NEURAL_PAPER_SKILL)
  return resolve(root, '..', 'Neural_Paper_Skill', 'skills', 'neural-paper-workflow')
}

/** 把 JSON 里可能是数组、也可能是字符串形态数组的字段统一成字符串数组。 */
function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim() !== '')
  if (typeof value !== 'string') return []
  const raw = value.trim()
  if (raw === '' || raw === '[]') return []
  // 源文件里不少字段被序列化成 "['a', 'b']" 这样的字符串。
  try {
    const parsed = JSON.parse(raw.replace(/'/g, '"'))
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string')
  } catch {
    /* 不是 JSON 数组就按普通字符串处理 */
  }
  return [raw]
}

function text(value, limit) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
}

function loadEntries(directory) {
  const graph = join(directory, 'knowledge', 'graph')
  if (!existsSync(graph)) throw new Error(`找不到知识图谱目录：${graph}`)
  const files = readdirSync(graph).filter((name) => /^NP\d+\.json$/.test(name)).sort()
  const entries = []
  for (const name of files) {
    let raw
    try {
      raw = JSON.parse(readFileSync(join(graph, name), 'utf8'))
    } catch {
      continue
    }
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : name.replace('.json', '')
    entries.push({
      id,
      title: text(raw.title, 160),
      category: text(raw.category, 40),
      ktype: text(raw.ktype, 24),
      severity: text(raw.severity, 20),
      stage: text(raw.stage, 40),
      status: text(raw.status, 20),
      // 检索用：症状签名（正则）+ 触发词。
      signature: asList(raw.error_signature),
      triggers: asList(raw.trigger_phrases),
      // 摘要：命中后先给这一段，够判断要不要取全文。
      gist: text(raw.rec_approach ?? raw.root_cause ?? '', 260),
      // 全文（按需取）。
      full: {
        rootCause: text(raw.root_cause, 700),
        behavioralRootCause: text(raw.behavioral_root_cause, 500),
        approach: text(raw.rec_approach, 1600),
        command: text(raw.rec_command ?? raw.verification_cmd, 500),
        forbid: asList(raw.forbid),
        forbidReason: text(raw.forbid_reason, 400),
        forbidConsequence: text(raw.forbid_consequence, 400),
        verify: text(raw.verification_cmd, 500),
        fallback: text(raw.fallback_approach, 500),
        fallbackCommand: text(raw.fallback_command, 400),
        principles: asList(raw.principles),
        updated: text(raw.last_updated, 20),
      },
    })
  }
  return entries
}

function emit(entries) {
  // 索引要小：只放"能不能命中"需要的字段。签名正则与触发词合并成一个检索串，
  // 描述性长文一律留在全文里按 id 取——这是渐进披露的边界。
  const index = entries.map((entry) => ({
    i: entry.id,
    t: entry.title,
    c: entry.category,
    k: entry.ktype,
    s: entry.severity,
    st: entry.stage,
    // 检索串：触发词 + 症状签名 + 标题（去重后拼起来，供一次性模糊匹配）
    q: [...new Set([...entry.triggers, ...entry.signature, entry.title].map((item) => item.trim()).filter(Boolean))].join(' | '),
  }))
  const full = Object.fromEntries(entries.map((entry) => [entry.id, entry.full]))

  const indexBody = `/** 生成文件：由 scripts/build-kb.mjs 从 skills/neural-paper-workflow/knowledge/graph 生成，勿手改。 */
export const KB_ENTRIES = ${JSON.stringify(index, null, 0)}
`
  const fullBody = `/** 生成文件：由 scripts/build-kb.mjs 生成，勿手改。按 id 取全文，只给真正命中的条目。 */
export const KB_FULL = ${JSON.stringify(full, null, 0)}
`
  return { indexBody, fullBody, count: entries.length }
}

/**
 * 源知识库是否可达。
 *
 * 知识库的源在**另一个（私有）仓库**里，所以干净检出上它必然缺席。
 * 这时 `--check` 不能硬失败（CI 会永远红），也不能静默通过（那是假绿）。
 * 折中：明确降级为"只校验产物自洽"，并把降级本身打印出来——
 * 读日志的人一眼能看出这次没有做源比对。
 */
const directory = skillDir()
const sourceAvailable = existsSync(join(directory, 'knowledge', 'graph'))

/**
 * 产物自洽校验：不解源也能证伪的那部分。
 *
 * 查的是"生成文件是否被手改坏 / 是否与检索逻辑对不上"，而不是"是否与源同步"。
 * 两者不能互相冒充：源比对需要源，产物校验不需要。
 */
function verifyArtifacts() {
  const problems = []
  let index
  let full
  const readGenerated = (relative, marker) => {
    const body = readFileSync(join(root, relative), 'utf8')
    const at = body.indexOf(marker)
    if (at < 0) throw new Error(`缺少 ${marker} 导出`)
    return JSON.parse(body.slice(at + marker.length).trim())
  }
  try {
    index = readGenerated('lib/kb-data.js', 'export const KB_ENTRIES =')
  } catch (error) {
    problems.push(`lib/kb-data.js 不是合法产物：${error.message}`)
  }
  try {
    full = readGenerated('lib/kb-full.js', 'export const KB_FULL =')
  } catch (error) {
    problems.push(`lib/kb-full.js 不是合法产物：${error.message}`)
  }
  if (Array.isArray(index) && full !== undefined) {
    if (index.length === 0) problems.push('索引为空')
    const ids = new Set()
    for (const entry of index) {
      if (typeof entry.i !== 'string' || entry.i === '') problems.push('索引里有条目缺 id')
      if (ids.has(entry.i)) problems.push(`索引里 id 重复：${entry.i}`)
      ids.add(entry.i)
      if (typeof entry.q !== 'string' || entry.q === '') problems.push(`条目 ${entry.i} 的检索串为空（永远搜不到）`)
      if (full[entry.i] === undefined) problems.push(`条目 ${entry.i} 在全文表里缺失（命中后取不到全文）`)
    }
    for (const id of Object.keys(full)) {
      if (!ids.has(id)) problems.push(`全文表里的 ${id} 不在索引里（永远取不到）`)
    }
  }
  return { problems, count: Array.isArray(index) ? index.length : 0 }
}

if (!sourceAvailable && check) {
  const { problems, count } = verifyArtifacts()
  if (problems.length > 0) {
    for (const problem of problems) console.error(`build-kb: ${problem}`)
    process.exit(1)
  }
  console.warn(`build-kb: 源知识库不可达（${directory}），已降级为产物自洽校验（${count} 条）；未做与源的逐字比对`)
  console.log(`build-kb: 校验通过（${count} 条，产物自洽）`)
  process.exit(0)
}

const entries = loadEntries(directory)
const { indexBody, fullBody, count } = emit(entries)

const targets = [
  [join(root, 'lib', 'kb-data.js'), indexBody],
  [join(root, 'lib', 'kb-full.js'), fullBody],
]

if (check) {
  let stale = false
  for (const [path, expected] of targets) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== expected) {
      console.error(`build-kb: ${path} 与源知识库不一致；请运行 node scripts/build-kb.mjs`)
      stale = true
    }
  }
  if (stale) process.exit(1)
  console.log(`build-kb: 校验通过（${count} 条）`)
} else {
  for (const [path, body] of targets) writeFileSync(path, body, 'utf8')
  console.log(`build-kb: 已生成 ${count} 条 → lib/kb-data.js, lib/kb-full.js`)
}
