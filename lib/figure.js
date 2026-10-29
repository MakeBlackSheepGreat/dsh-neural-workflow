/**
 * Figure 审计编排（host 平面，纯函数 + 受管子进程）。
 *
 * 为什么需要这一层，而不是直接把现成的 5 个检测器暴露给模型：
 *
 *   ① **接口不一致**。`check_figure_structure/semantics` 要 `--file`，
 *      `geometry` 要 `--drawio`，`rendering` 要 `--file` 且依赖外部 CLI，
 *      报告字段一个叫 `checks` 一个叫 `axes`。让模型记住这些差异是浪费上下文，
 *      记错了就是一次假调用。这里统一成 `{ file, format, status, score, checks[] }`。
 *
 *   ② **两种故障模式必须先被识别出来，否则工具本身会骗人**：
 *      · `check_figure_rendering` 在找不到 draw.io CLI 时返回
 *        `status=PASS, score=100`，所有检查标 `SKIP`——这是**假绿**，
 *        实测确认过。编排层把它降级为 `SKIPPED`，绝不让它冒充通过。
 *      · `check_figure_quality` 遇到不可解析的文件会**抛异常退出**，
 *        不输出 JSON。编排层捕获非零退出与坏 JSON，转成一条 `ERROR` 检查。
 *
 *   ③ 模型要的是"这张图有什么问题"，不是五个原始报告。这里做去重与排序：
 *      同一处缺陷常被两个检测器各报一次，两份重复会把真正的问题挤出视野。
 *
 * 支持的格式由检测器的实际能力决定，不吹：
 *   · `.drawio` —— 全部检测器
 *   · `.pdf`    —— geometry 的印刷字号检查
 *   · `.png/.jpg/.svg` —— 只能拿来做**参考图比对**，不能单独做结构检查
 *      （结构/语义/几何都要读 XML，位图里没有 XML）
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 检测器定义：id → 脚本名、参数字段名、报告字段名、适用格式。 */
const DETECTORS = [
  {
    id: 'structure',
    title: '结构纪律',
    script: 'check_figure_structure.py',
    flag: '--file',
    listKey: 'checks',
    formats: ['.drawio'],
    // 与 SKILL 的 figure contract 对应：这四条是硬要求。
    weight: 1,
  },
  {
    id: 'semantics',
    title: '语义约定',
    script: 'check_figure_semantics.py',
    flag: '--file',
    listKey: 'checks',
    formats: ['.drawio'],
    weight: 1,
  },
  {
    id: 'geometry',
    title: '几何约束',
    script: 'check_figure_geometry.py',
    flag: '--drawio',
    listKey: 'checks',
    formats: ['.drawio'],
    weight: 1,
  },
  {
    id: 'quality',
    title: '质量评分',
    script: 'check_figure_quality.py',
    flag: '--file',
    listKey: 'axes',
    formats: ['.drawio'],
    weight: 1,
  },
  {
    id: 'rendering',
    title: '渲染质量',
    script: 'check_figure_rendering.py',
    flag: '--file',
    listKey: 'checks',
    formats: ['.drawio'],
    weight: 1,
    // 这条检测器在缺依赖时会假绿，编排层要特别处理。
    requiresExternal: 'draw.io CLI',
  },
]

/** 状态归一：检测器之间五花八门（PASS/WARN/FAIL/SKIP/OK），统一成五个字。 */
function normalizeStatus(value) {
  const raw = String(value ?? '').toUpperCase()
  if (raw === 'PASS' || raw === 'OK' || raw === 'SUCCESS') return 'PASS'
  if (raw === 'WARN' || raw === 'WARNING') return 'WARN'
  if (raw === 'FAIL' || raw === 'ERROR') return 'FAIL'
  if (raw === 'SKIP' || raw === 'SKIPPED') return 'SKIP'
  return 'UNKNOWN'
}

/** 状态严重度，用于排序与总判定。 */
const SEVERITY = { FAIL: 3, ERROR: 3, WARN: 2, UNKNOWN: 2, SKIP: 1, PASS: 0 }

/**
 * 从检测器的原始输出里抽出可比较的检查项。
 *
 * 两种字段名（`checks` / `axes`）在这里被抹平；`name` 与 `check` 也统一成 `id`。
 */
function extractChecks(detector, raw) {
  const list = Array.isArray(raw?.[detector.listKey]) ? raw[detector.listKey] : []
  return list.map((item, index) => ({
    detector: detector.id,
    id: String(item?.name ?? item?.check ?? item?.axis ?? `item-${index}`),
    status: normalizeStatus(item?.status),
    message: String(item?.message ?? ''),
    detail: item?.detail,
  }))
}

/**
 * 判定"这条检测器是不是根本没跑"。
 *
 * 这是本文件最重要的一段。实测 `check_figure_rendering` 在找不到 draw.io CLI 时：
 *   { "status": "PASS", "score": 100, "checks": [{ "status": "SKIP", ... }] }
 * 如果原样上报，工具就在撒谎——模型会以为渲染检查通过了，而实际一个字都没看。
 * 这里把"有 SKIP 且没有一条实际检查"判定为 SKIPPED，并明确写出缺什么。
 */
function attributeSkips(detector, raw, checks) {
  if (checks.length === 0) return { skipped: true, reason: '没有产出任何检查项' }
  const active = checks.filter((item) => item.status !== 'SKIP')
  if (active.length > 0) return { skipped: false }
  const reason = checks.map((item) => item.message).filter(Boolean).join('；')
  const missing = detector.requiresExternal === undefined ? '' : `（缺少 ${detector.requiresExternal}）`
  return { skipped: true, reason: `${reason}${missing}` }
}

/** 解析一条检测器的 stdout；非 JSON 说明脚本崩了，如实报错而不是吞掉。 */
function parseReport(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') throw new Error('没有输出')
  // 有些检测器会在 JSON 前后打印提示行，取第一个 { 到最后一个 }。
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('输出不是 JSON')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/** 识别文件格式。不靠扩展名猜"能不能检查"，只用来决定跑哪些检测器。 */
export function formatOf(file) {
  const extension = extname(String(file ?? '')).toLowerCase()
  if (extension === '.drawio') return 'drawio'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.png' || extension === '.jpg' || extension === '.jpeg' || extension === '.webp') return 'image'
  if (extension === '.svg') return 'svg'
  return 'unknown'
}

/** 每种格式**实际**能做什么，写清楚，避免调用方以为位图也能做结构检查。 */
export const FORMAT_CAPABILITIES = {
  drawio: {
    detectors: ['structure', 'semantics', 'geometry', 'quality', 'rendering'],
    note: '全部检测器可用：结构、语义、几何、质量、渲染都读 XML 或由 XML 渲染。',
  },
  pdf: {
    detectors: ['geometry'],
    note: '只能做印刷字号检查（geometry 的 printed_font_floor）。结构与语义要读 XML，PDF 里没有。',
  },
  image: {
    detectors: [],
    note: '位图不含 XML，无法做结构/语义/几何检查；只能作为 --reference 供渲染比对。',
  },
  svg: {
    detectors: [],
    note: 'SVG 结构不等于 Draw.io 模型（缺少 mxCell 语义），当前检测器不支持，需提供原始 .drawio。',
  },
  unknown: { detectors: [], note: '无法识别的格式。' },
}

/**
 * 解析 skill 的脚本目录。
 *
 * 顺序：显式参数 → 环境变量 → 与插件同级的 sibling 仓。找不到就**明说找不到**，
 * 不要把"没有检测器"伪装成"没有问题"。
 */
export function resolveSkillDir(config, home) {
  const candidates = []
  if (typeof config?.figureSkillDir === 'string' && config.figureSkillDir !== '') candidates.push(config.figureSkillDir)
  if (typeof process.env.NEURAL_PAPER_SKILL === 'string' && process.env.NEURAL_PAPER_SKILL !== '') {
    candidates.push(process.env.NEURAL_PAPER_SKILL)
  }
  if (typeof home === 'string' && home !== '') {
    candidates.push(join(home, 'Neural_Paper_Skill', 'skills', 'neural-paper-workflow'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'scripts', 'check_figure_structure.py'))) return resolve(candidate)
  }
  return undefined
}

/** 选一个可用的 python：优先 python，退回 python3。找不到就报出来。 */
async function pickPython() {
  for (const candidate of ['python', 'python3']) {
    try {
      await run(candidate, ['--version'], { timeout: 10000 })
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return undefined
}

/**
 * 审计一张图。
 *
 * `options.detectors` 可限定只跑某几个（缺省全跑）；`options.rules` 传给检测器。
 * 返回结构固定，便于模型稳定解析：
 *   { file, format, status, score, ran[], skipped[], checks[], summary }
 */
export async function auditFigure(file, options = {}) {
  const target = isAbsolute(file) ? file : resolve(file)
  const format = formatOf(target)
  const capability = FORMAT_CAPABILITIES[format] ?? FORMAT_CAPABILITIES.unknown

  if (!existsSync(target)) {
    return {
      file: target,
      format,
      status: 'ERROR',
      score: 0,
      ran: [],
      skipped: [],
      checks: [{ detector: 'io', id: 'exists', status: 'FAIL', message: `文件不存在：${target}` }],
      summary: '文件不存在。',
    }
  }
  if (statSync(target).isDirectory()) {
    return {
      file: target,
      format,
      status: 'ERROR',
      score: 0,
      ran: [],
      skipped: [],
      checks: [{ detector: 'io', id: 'not_a_file', status: 'FAIL', message: `${target} 是目录` }],
      summary: '需要文件，不是目录。',
    }
  }

  const skillDir = resolveSkillDir(options.config, options.home)
  if (skillDir === undefined) {
    return {
      file: target,
      format,
      status: 'ERROR',
      score: 0,
      ran: [],
      skipped: [],
      checks: [
        {
          detector: 'setup',
          id: 'skill_dir',
          status: 'FAIL',
          // 找不到检测器 ≠ 图没问题。这两件事必须分开，否则工具在骗人。
          message: '找不到 neural-paper-workflow 的脚本目录；设置 figureSkillDir 或环境变量 NEURAL_PAPER_SKILL。未执行任何检查，因此**不能**据此认为图没有问题。',
        },
      ],
      summary: '未执行检查（缺检测器）。',
    }
  }

  const python = await pickPython()
  if (python === undefined) {
    return {
      file: target,
      format,
      status: 'ERROR',
      score: 0,
      ran: [],
      skipped: [],
      checks: [{ detector: 'setup', id: 'python', status: 'FAIL', message: '找不到可用的 python 解释器（试过 python 与 python3）。未执行任何检查。' }],
      summary: '未执行检查（缺 python）。',
    }
  }

  // 只跑"这个格式真能跑"且"调用方要求"的检测器。
  const wanted = Array.isArray(options.detectors) && options.detectors.length > 0 ? new Set(options.detectors) : undefined
  const selected = DETECTORS.filter(
    (detector) => capability.detectors.includes(detector.id) && (wanted === undefined || wanted.has(detector.id)),
  )

  const checks = []
  const ran = []
  const skipped = []
  let weightSum = 0
  let weightedScore = 0

  for (const detector of selected) {
    const scriptPath = join(skillDir, 'scripts', detector.script)
    const args = [scriptPath, detector.flag, target]
    if (typeof options.rules === 'string' && options.rules !== '') args.push('--rules', options.rules)
    /**
     * 跑一个检测器。
     *
     * **退出码不能当判定**：实测 check_figure_geometry 与 check_figure_quality
     * 在**发现问题时**以退出码 1 结束，而 stdout 上的 JSON 完全有效。
     * 把非零退出一律当成崩溃，会把"报告了 6 条几何缺陷"误报成"检测器没跑成"——
     * 那样最需要看见的缺陷反而消失了。
     *
     * 所以：先看 stdout 能不能解析成 JSON。能，就用它（退出码只作为附注）；
     * 不能，才是真的崩了，这时才归 ERROR 并带上 stderr。
     */
    let parsed
    let exitCode = 0
    try {
      const result = await run(python, args, { timeout: options.timeoutMs ?? 120000, maxBuffer: 32 * 1024 * 1024 })
      parsed = parseReport(result.stdout)
    } catch (error) {
      // 失败时 child_process 把 stdout/stderr 挂在 error 上；先尝试抢救 stdout。
      exitCode = typeof error?.code === 'number' ? error.code : 1
      try {
        parsed = parseReport(error?.stdout)
      } catch {
        const stderr = String(error?.stderr ?? '').trim().split('\n').slice(-3).join(' ')
        checks.push({
          detector: detector.id,
          id: 'crashed',
          status: 'ERROR',
          message: `${detector.title} 未能完成：${stderr === '' ? String(error?.message ?? error) : stderr}`,
        })
        skipped.push({ detector: detector.id, reason: '执行失败（没有可解析的报告）' })
        continue
      }
    }

    const extracted = extractChecks(detector, parsed)
    const skipInfo = attributeSkips(detector, parsed, extracted)
    if (skipInfo.skipped) {
      skipped.push({ detector: detector.id, reason: skipInfo.reason })
      // 不把"跳过"的项当检查结果混进去：它们没有判定力。
      continue
    }

    ran.push(detector.id)
    // 附注非零退出：报告有效，但检测器自己认为不合格。两者不矛盾。
    checks.push(...extracted.map((item) => (exitCode === 0 ? item : { ...item, exitCode })))
    const score = Number.isFinite(parsed?.score) ? parsed.score : 0
    weightSum += detector.weight
    weightedScore += score * detector.weight
  }

  // 总判定：任何 FAIL > ERROR 优先于 WARN；全跳过则如实说全跳过。
  const normalizedChecks = checks.map((item) => ({ ...item, status: normalizeStatus(item.status) }))
  const worst = normalizedChecks.reduce((acc, item) => Math.max(acc, SEVERITY[item.status] ?? 2), 0)
  const status = worst >= 3 ? 'FAIL' : worst === 2 ? 'WARN' : ran.length === 0 ? 'ERROR' : 'PASS'
  const score = weightSum === 0 ? 0 : Math.round(weightedScore / weightSum)

  /**
   * 去重：同一处缺陷常被两个检测器各报一次（比如"标签溢出"既属语义也属质量）。
   * 按 message 归一化后只留第一条，避免重复项把真问题挤出视野。
   */
  const seen = new Set()
  const deduped = []
  for (const item of normalizedChecks) {
    const key = `${item.status}|${String(item.message).replace(/\s+/g, ' ').slice(0, 120)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  // 排序：先按严重度，再按检测器，保证两次调用顺序稳定（可 diff）。
  deduped.sort(
    (left, right) =>
      (SEVERITY[right.status] ?? 2) - (SEVERITY[left.status] ?? 2) ||
      left.detector.localeCompare(right.detector) ||
      left.id.localeCompare(right.id),
  )

  const failed = deduped.filter((item) => item.status === 'FAIL' || item.status === 'ERROR')
  const warned = deduped.filter((item) => item.status === 'WARN')
  const summary =
    ran.length === 0
      ? `未执行任何检查（${skipped.map((item) => `${item.detector}: ${item.reason}`).join('；')}）。这不代表图没有问题。`
      : `${ran.length} 项检测完成：${failed.length} 条失败，${warned.length} 条警告` +
        (skipped.length > 0 ? `；${skipped.length} 项跳过（${skipped.map((item) => item.detector).join(', ')}）` : '') +
        `。${capability.note}`

  return {
    file: target,
    format,
    status,
    score,
    ran,
    skipped,
    checks: deduped,
    summary,
  }
}

/** 供工具描述使用：把"能做什么"如实列出来。 */
export function describeCapabilities() {
  return Object.entries(FORMAT_CAPABILITIES)
    .filter(([format]) => format !== 'unknown')
    .map(([format, value]) => `- ${format}: ${value.detectors.length === 0 ? '无检测器' : value.detectors.join(', ')}。${value.note}`)
    .join('\n')
}

export const DETECTOR_IDS = DETECTORS.map((detector) => detector.id)
