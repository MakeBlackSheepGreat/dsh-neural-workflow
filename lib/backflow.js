/**
 * dsh-neural-workflow — 经验回流（host 平面）。
 *
 * 把 ExperienceStore 里的运行时经验送进 skill 知识图谱，走的是
 * `draft → 人工 promote` 两段路，绝不自动升格：
 *
 *   ① writeDraft(record)：把一条经验折成草稿对象，写进草稿区
 *      `<draftsDir>/DRAFT-<hash8>.json`。同一经验重复写时内容一致就跳过，
 *      不一致（同 id 不同正文）说明经验被改过，报错让人来看。
 *   ② promoteDraft(draftId, npId, {explicit})：**必须**人工 explicit===true
 *      且给出显式 NP 编号，才把这份草稿写进 `<graphDir>/<npId>.json`
 *      （已存在则拒绝——不覆盖任何正式条目），并把草稿文件标记
 *      status:'promoted'。否则一律抛错。
 *
 * 纪律：本模块只写草稿区与被显式指定的那一个 NP 文件；不扫描图谱、
 * 不批量、不改其它 NP。草稿 id 派生自经验内容（确定性 hash），
 * 所以同一条经验无论回流几次都落同一个文件——幂等，而不是越堆越多。
 *
 * 时间从构造函数注入（`now()`），测试不依赖真实时钟。
 * 纯 ESM，只用 node:fs / node:path / node:crypto，零第三方依赖。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 允许的经验类型（与 experience.js 同一口径）。 */
const KINDS = new Set(['lesson', 'negative', 'idea'])

/** kind → 图谱 category 映射（契约固定）。 */
const CATEGORY_BY_KIND = { lesson: 'method', negative: 'error', idea: 'idea' }

/** 草稿 id 形如 DRAFT-<8 位十六进制>；NP 编号形如 NP<数字>。 */
const DRAFT_ID_RE = /^DRAFT-[0-9a-f]{8}$/
const NP_ID_RE = /^NP\d+$/

/** error_signature 最多抽几句关键句：够人判断"在说哪件事"即可。 */
const MAX_SIGNATURES = 3

/* ------------------------------------------------------------------ */
/* 纯函数工具                                                          */
/* ------------------------------------------------------------------ */

/** 键序无关的序列化：用来比较两份草稿是否"内容一致"。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** 把注入的 now() 归一成 ISO 字符串；非法时间直接报错，不静默变成 1970。 */
function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`now() 返回了非法时间: ${String(value)}`)
  return date.toISOString()
}

/** 内容确定性短哈希：同一条经验永远折出同一个草稿 id。 */
function hash8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 从 body 抽关键句：按中英文句读切分，去重、去空，最多取 MAX_SIGNATURES 句。
 * 抽出来的是"原句"，不是改写——草稿供人审，不替人下结论。
 */
function extractSignatures(body) {
  if (typeof body !== 'string' || body.trim() === '') return []
  const seen = new Set()
  const out = []
  for (const raw of body.split(/[。！？!?\n；;]+/)) {
    const sentence = raw.trim()
    if (sentence === '' || seen.has(sentence)) continue
    seen.add(sentence)
    out.push(sentence)
    if (out.length >= MAX_SIGNATURES) break
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 草稿生成                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一条 ExperienceStore 记录折成草稿对象。
 *
 * @param {object} record  经验记录：{id, title, body, kind, ...}
 * @param {() => Date|string} [now]  可选时钟；Backflow 会传入自己注入的 now()，
 *   缺省回退到 record.createdAt，再缺省用当前时间（保持纯函数可直接调用）。
 * @returns 草稿对象（契约字段：draftId/title/category/ktype/error_signature/
 *   rec_approach/forbid/source_event/status/created_at）
 */
export function draftFromExperience(record, now) {
  if (record === null || typeof record !== 'object') {
    throw new TypeError('draftFromExperience 需要一条经验记录对象')
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    throw new TypeError('经验记录缺少 id，无法溯源 source_event')
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    throw new TypeError('经验记录缺少 title')
  }
  if (typeof record.body !== 'string') {
    throw new TypeError('经验记录的 body 必须是字符串')
  }
  if (!KINDS.has(record.kind)) {
    throw new RangeError(`未知经验 kind: ${String(record.kind)}`)
  }

  const createdAt = now !== undefined ? toIso(typeof now === 'function' ? now() : now) : undefined
  return {
    draftId: `DRAFT-${hash8(`${record.id}|${record.title}`)}`,
    title: record.title,
    category: CATEGORY_BY_KIND[record.kind],
    ktype: CATEGORY_BY_KIND[record.kind],
    error_signature: extractSignatures(record.body),
    rec_approach: record.body,
    forbid: record.kind === 'negative' ? [record.title] : [],
    source_event: `dsh-neural-workflow experience ${record.id}`,
    status: 'draft',
    created_at: createdAt ?? (typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString()),
  }
}

/* ------------------------------------------------------------------ */
/* 草稿区 / 图谱 IO                                                     */
/* ------------------------------------------------------------------ */

/** 校验草稿 id 并解析草稿文件路径；顺手挡掉路径穿越（../ 之类直接拒绝）。 */
function draftPath(draftsDir, draftId) {
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) {
    throw new RangeError(`非法草稿 id: ${String(draftId)}（期望 DRAFT-<8 位十六进制>）`)
  }
  return path.join(draftsDir, `${draftId}.json`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 经验回流器：只碰草稿区与被显式指定的那一个 NP 文件。
 */
export class Backflow {
  /**
   * @param {object} options
   * @param {string} options.draftsDir  草稿区目录（<skillDir>/knowledge/drafts/）
   * @param {string} options.graphDir   知识图谱目录（<skillDir>/knowledge/graph/）
   * @param {() => Date} [options.now]  注入时钟，测试不依赖真实时间
   */
  constructor({ draftsDir, graphDir, now } = {}) {
    if (typeof draftsDir !== 'string' || draftsDir.trim() === '') {
      throw new TypeError('Backflow 需要非空的 draftsDir')
    }
    if (typeof graphDir !== 'string' || graphDir.trim() === '') {
      throw new TypeError('Backflow 需要非空的 graphDir')
    }
    this.draftsDir = draftsDir
    this.graphDir = graphDir
    this.now = typeof now === 'function' ? now : () => new Date()
  }

  /**
   * 把一条经验写成草稿文件 `<draftsDir>/<draftId>.json`。
   * 同名已存在：内容一致 → 跳过（幂等，保留首次的 created_at）；
   * 不一致 → 抛错（经验被改过，人来裁决）。
   * 比较时排除 created_at：同一经验隔天再回流，时间戳不同不算改过内容。
   * @returns {{draft: object, skipped: boolean}}
   */
  writeDraft(record) {
    const draft = draftFromExperience(record, this.now)
    const file = draftPath(this.draftsDir, draft.draftId)
    if (fs.existsSync(file)) {
      const existing = readJson(file)
      const identityOf = (value) => stableStringify({ ...value, created_at: undefined })
      if (identityOf(existing) !== identityOf(draft)) {
        throw new Error(`草稿冲突：${draft.draftId} 已存在且内容不一致，请人工核对 ${file}`)
      }
      return { draft: existing, skipped: true }
    }
    writeJson(file, draft)
    return { draft, skipped: false }
  }

  /**
   * 列出草稿区里的草稿摘要（只认 DRAFT-<hash8>.json；坏文件跳过，不抛）。
   * @returns Array<{draftId, title, status, created_at}>，按 draftId 排序
   */
  listDrafts() {
    if (!fs.existsSync(this.draftsDir)) return []
    const out = []
    for (const name of fs.readdirSync(this.draftsDir).sort()) {
      if (!DRAFT_ID_RE.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue
      try {
        const draft = readJson(path.join(this.draftsDir, name))
        if (draft === null || typeof draft !== 'object') continue
        out.push({
          draftId: typeof draft.draftId === 'string' ? draft.draftId : draft.id,
          title: draft.title,
          status: draft.status,
          created_at: draft.created_at,
        })
      } catch {
        // 坏草稿文件不挡别的草稿；回流是给人看的清单，坏文件留给人工清理。
      }
    }
    return out
  }

  /** 读一份完整草稿；不存在或 id 非法都抛错。 */
  readDraft(draftId) {
    const file = draftPath(this.draftsDir, draftId)
    if (!fs.existsSync(file)) {
      throw new Error(`未知草稿 id: ${draftId}（${file} 不存在）`)
    }
    return readJson(file)
  }

  /**
   * 人工升格：把草稿写进图谱 `<graphDir>/<npId>.json`，并把草稿文件标记
   * status:'promoted'。explicit 必须 === true；npId 必须显式给出且匹配
   * /^NP\d+$/；NP 文件已存在则拒绝。绝不静默自动升格。
   * @returns {{draftId: string, npId: string, graphPath: string}}
   */
  promoteDraft(draftId, npId, { explicit } = {}) {
    if (explicit !== true) {
      throw new Error('promoteDraft 需要人工确认：{ explicit: true }（绝不自动升格）')
    }
    if (typeof npId !== 'string' || !NP_ID_RE.test(npId)) {
      throw new RangeError(`非法 NP 编号: ${String(npId)}（期望 NP<数字>，例如 NP601）`)
    }

    const draft = this.readDraft(draftId)
    if (draft.status !== 'draft') {
      throw new Error(`草稿 ${draftId} 状态为 ${String(draft.status)}，只有 status:'draft' 的草稿能 promote`)
    }

    const graphPath = path.join(this.graphDir, `${npId}.json`)
    if (fs.existsSync(graphPath)) {
      throw new Error(`NP 冲突：${npId} 已存在于 ${graphPath}，不覆盖正式条目`)
    }

    writeJson(graphPath, draft)
    writeJson(draftPath(this.draftsDir, draftId), { ...draft, status: 'promoted' })
    return { draftId, npId, graphPath }
  }
}
