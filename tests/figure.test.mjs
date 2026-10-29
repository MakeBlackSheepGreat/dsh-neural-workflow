/**
 * Figure 审计编排的测试。
 *
 * 重点不是"能返回报告"，而是**三种会骗人的情形各自有对应的反证**：
 *   ① 检测器缺依赖时假绿（rendering 返回 PASS/100 全 SKIP）——必须降级为 SKIPPED。
 *   ② 检测器发现问题时以退出码 1 结束——报告有效，不许当成崩溃。
 *   ③ 找不到检测器目录——必须报"未执行检查"，不许当成"图没问题"。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { DETECTOR_IDS, FORMAT_CAPABILITIES, auditFigure, formatOf, resolveSkillDir } from '../lib/figure.js'

/** 用来跑真检测器的样例图（skill 仓里的 figure-kit）。 */
const SKILL_HOME = 'C:/Users/876762330/Desktop/projects'
const SAMPLE = join(SKILL_HOME, 'Neural_Paper_Skill', 'skills', 'neural-paper-workflow', 'assets', 'templates', 'figure-kit', 'out', 'figure_kit_example.drawio')
const hasSample = existsSync(SAMPLE)

test('格式识别：按扩展名分类，未知一律 unknown', () => {
  assert.equal(formatOf('a.drawio'), 'drawio')
  assert.equal(formatOf('a.PDF'), 'pdf')
  assert.equal(formatOf('a.png'), 'image')
  assert.equal(formatOf('a.jpg'), 'image')
  assert.equal(formatOf('a.svg'), 'svg')
  assert.equal(formatOf('a.docx'), 'unknown')
  assert.equal(formatOf(''), 'unknown')
})

test('格式能力如实声明：位图与 SVG 没有检测器', () => {
  // 这条是防"工具假装能检查位图"：结构/语义/几何都要读 XML，位图里没有。
  assert.deepEqual(FORMAT_CAPABILITIES.image.detectors, [])
  assert.deepEqual(FORMAT_CAPABILITIES.svg.detectors, [])
  assert.deepEqual(FORMAT_CAPABILITIES.pdf.detectors, ['geometry'])
  assert.deepEqual(FORMAT_CAPABILITIES.drawio.detectors, DETECTOR_IDS)
  // 每种格式都必须有一句人话说明，不许空着。
  for (const [, value] of Object.entries(FORMAT_CAPABILITIES)) {
    if (value === undefined) continue
    assert.ok(typeof value.note === 'string' && value.note.length > 5, '每种格式都要说明能做什么')
  }
})

test('文件不存在：ERROR，且不执行任何检测器', async () => {
  const report = await auditFigure('definitely-not-here.drawio', { home: SKILL_HOME })
  assert.equal(report.status, 'ERROR')
  assert.equal(report.ran.length, 0)
  assert.equal(report.checks[0].id, 'exists')
  // 关键：必须说清"没检查"，而不是"没问题"。
  assert.match(report.summary, /不存在/)
})

test('目录而不是文件：ERROR', async () => {
  const report = await auditFigure(SKILL_HOME, { home: SKILL_HOME })
  assert.equal(report.status, 'ERROR')
  assert.equal(report.checks[0].id, 'not_a_file')
})

test('找不到检测器目录：必须报未执行，不许当成通过', async () => {
  // 文件必须真实存在，否则会先命中"文件不存在"，测不到 skillDir 这一层。
  const tempDir = mkdtempSync(join(tmpdir(), 'nw-figure-'))
  const tempFile = join(tempDir, 'x.drawio')
  writeFileSync(tempFile, '<mxGraphModel/>', 'utf8')
  const saved = process.env.NEURAL_PAPER_SKILL
  delete process.env.NEURAL_PAPER_SKILL
  try {
    const report = await auditFigure(tempFile, { home: '/nonexistent-home-xyz' })
    assert.equal(report.status, 'ERROR')
    assert.equal(report.ran.length, 0)
    const check = report.checks.find((item) => item.id === 'skill_dir')
    assert.ok(check !== undefined, '必须指名是缺检测器目录')
    assert.match(check.message, /不能.*认为图没有问题/, '必须明说不能据此认为图没问题')
  } finally {
    if (saved !== undefined) process.env.NEURAL_PAPER_SKILL = saved
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('位图：没有可用检测器，且说明原因', async () => {
  const report = await auditFigure('photo.png', { home: SKILL_HOME })
  // 先命中"文件不存在"，所以这里只断言能力声明路径不抛错。
  assert.equal(report.format, 'image')
})

test('真实 drawio：多个检测器执行，报告结构稳定', { skip: !hasSample }, async () => {
  const report = await auditFigure(SAMPLE, { home: SKILL_HOME })
  assert.equal(report.format, 'drawio')
  // 至少 structure 与 semantics 能在纯 Python 下跑起来。
  assert.ok(report.ran.includes('structure'), `应跑过 structure，实际 ${report.ran.join(',')}`)
  assert.ok(report.ran.includes('semantics'), `应跑过 semantics，实际 ${report.ran.join(',')}`)
  assert.ok(report.checks.length > 0, '必须有检查项')
  // 结构契约：每条检查都带 detector / id / status / message。
  for (const item of report.checks) {
    assert.ok(typeof item.detector === 'string' && item.detector !== '', '缺 detector')
    assert.ok(typeof item.id === 'string' && item.id !== '', '缺 id')
    assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP', 'ERROR', 'UNKNOWN'].includes(item.status), `非法状态 ${item.status}`)
    assert.ok(typeof item.message === 'string', '缺 message')
  }
  // 排序契约：严重度必须单调不增，否则两次调用顺序不同、无法 diff。
  const rank = { FAIL: 3, ERROR: 3, WARN: 2, UNKNOWN: 2, SKIP: 1, PASS: 0 }
  for (let index = 1; index < report.checks.length; index += 1) {
    assert.ok(rank[report.checks[index - 1].status] >= rank[report.checks[index].status], '检查项必须按严重度降序')
  }
})

test('假绿防护：未执行检查的检测器只出现在 skipped，不产生 PASS 项', { skip: !hasSample }, async () => {
  const report = await auditFigure(SAMPLE, { home: SKILL_HOME })
  // 环境中没有 draw.io CLI，rendering 一定跳过。它绝不许以 PASS 的身份出现。
  const renderingChecks = report.checks.filter((item) => item.detector === 'rendering')
  assert.deepEqual(renderingChecks, [], '跳过的检测器不得贡献任何检查项')
  if (report.skipped.some((item) => item.detector === 'rendering')) {
    const skip = report.skipped.find((item) => item.detector === 'rendering')
    assert.ok(typeof skip.reason === 'string' && skip.reason !== '', '跳过必须带原因')
  }
})

test('退出码不是判定：geometry / quality 报 FAIL 但仍算"已执行"', { skip: !hasSample }, async () => {
  /**
   * geometry 与 quality 在**发现问题时**以退出码 1 结束，stdout 上的 JSON 有效。
   *
   * 这条断言必须点名这两个检测器：只断言"有 FAIL 项"是不够的——
   * structure / semantics 也会报 FAIL，即使 geometry 被误当成崩溃，
   * 测试照样通过（实测过这个假通过）。所以要直接查 ran 成员。
   */
  const report = await auditFigure(SAMPLE, { home: SKILL_HOME })
  assert.ok(report.ran.includes('geometry'), `geometry 应当算已执行，实际 ran=${report.ran.join(',')}`)
  assert.ok(report.ran.includes('quality'), `quality 应当算已执行，实际 ran=${report.ran.join(',')}`)
  assert.ok(
    !report.skipped.some((item) => item.detector === 'geometry'),
    'geometry 不该出现在 skipped 里（它只是以非零退出报告了缺陷）',
  )
  // 而且它们报出来的缺陷必须真的进了 checks。
  assert.ok(report.checks.some((item) => item.detector === 'geometry' && item.status === 'FAIL'), 'geometry 的缺陷必须在报告里')
  assert.ok(report.checks.some((item) => item.detector === 'quality' && item.status === 'FAIL'), 'quality 的缺陷必须在报告里')
})

test('去重：同一条消息不会重复出现两次', { skip: !hasSample }, async () => {
  const report = await auditFigure(SAMPLE, { home: SKILL_HOME })
  const seen = new Set()
  for (const item of report.checks) {
    const key = `${item.status}|${String(item.message).replace(/\s+/g, ' ').slice(0, 120)}`
    assert.ok(!seen.has(key), `重复的检查项：${key}`)
    seen.add(key)
  }
})

test('限定 detectors：只跑被点名的', { skip: !hasSample }, async () => {
  const report = await auditFigure(SAMPLE, { home: SKILL_HOME, detectors: ['structure'] })
  assert.deepEqual(report.ran, ['structure'])
  assert.ok(report.checks.every((item) => item.detector === 'structure'))
})

test('resolveSkillDir：显式配置优先，找不到返回 undefined', () => {
  const fromHome = resolveSkillDir({}, SKILL_HOME)
  if (hasSample) assert.ok(typeof fromHome === 'string' && fromHome.includes('neural-paper-workflow'))
  assert.equal(resolveSkillDir({}, '/nonexistent-home-xyz'), undefined)
  // 显式配置指向真实目录时应当胜出。
  if (hasSample) {
    const explicit = join(SKILL_HOME, 'Neural_Paper_Skill', 'skills', 'neural-paper-workflow')
    assert.equal(resolveSkillDir({ figureSkillDir: explicit }, '/nonexistent-home-xyz'), resolve(explicit))
  }
})
