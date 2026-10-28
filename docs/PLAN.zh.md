# 实施计划：从约束工作流到可沉淀经验的 Auto research

判据只有一条：**仓库里有可运行实现 + 有测试 + 能过 `npm run check`** 才算完成。
只看文档不算完成；只写了函数但没接进运行路径也不算。

## 分工与写域

| 阶段 | 内容 | 归属 | 写域（仅这些文件） |
| --- | --- | --- | --- |
| P0 | 契约与分发基线：`dsh-plugin.json` v0.15、`docs/schema-baseline.json`、`scripts/check-release.mjs` | Lead | `dsh-plugin.json`、`docs/schema-baseline.json`、`scripts/check-release.mjs` |
| P1 | 组件行拆分：core / panel / kb / enforce 四行 | Lead | `cordis.patch.yml`、`lib/index.js`、`lib/panel.js`、`lib/enforce.js`、`lib/kb-host.js`、`lib/runtime.js`、`package.json` |
| P2 | clearAI 三条：不变量注册、失败可入账、词表校验 | Lead | `lib/index.js`、`lib/fold.js`、`lib/vocab.js`、`native/src/main.rs`、`PROTOCOL.md` |
| P3 | 经验生命周期（Veyra）：trust 阶梯 / 回流 / 反馈 / 范围 / 复发 | teammate `exp-lifecycle` | `lib/experience.js`、`tests/experience.test.mjs` |
| P4 | 执行器（Auto research P0）：前沿派发 / 证据生产 / 停机 | teammate `executor` | `lib/executor.js`、`tests/executor.test.mjs` |
| P5 | 原生件分平台预置与哈希回执 | Lead | `scripts/*`、`runtime/`、`.gitignore` |
| P6 | 集成、验证、提交、复盘 | Lead | 全部（冲突时以 Lead 为准） |

## 状态（2026-10-29）

| 阶段 | 状态 |
| --- | --- |
| P0 契约与分发基线 | 已完成（`dsh-plugin.json`、`docs/schema-baseline.json`、`check-release.mjs`） |
| P1 组件行拆分 | **未完成**（见文末「未做与原因」） |
| P2 clearAI 三条 | 已完成（不变量探针、failure 通道、词表校验） |
| P3 经验生命周期 | 已完成（20 项测试） |
| P4 执行器内核 | 已完成（34 项测试） |
| P5 原生件分平台 | **未完成** |
| P6 集成验证 | 已完成（plan/experience 已接进工具并实例实测） |

## 验收标准

### P0 契约与分发
- `dsh-plugin.json` 通过 schema 形状（manifestVersion 0.15、id、facets.host.entry、permissions、contributes.x-display）。
- `docs/schema-baseline.json` 由 `scripts/check-release.mjs --snapshot` 生成；`--check` 在契约漂移时非零退出并指出差异字段。
- 基线覆盖：工具参数 schema、图节点/边字段、线协议 op 与错误码、证据记录字段。

### P1 组件行
- `cordis.patch.yml` 插入 4 行：`neural-workflow-core`（必需）、`neural-workflow-panel`、`neural-workflow-kb`、`neural-workflow-enforce`（可关）。
- 关掉 panel 行：面板路由消失，但工具与投影仍工作。
- 关掉 kb 行：`action=knowledge` 明确报“能力未装载”，不是静默空结果。
- 关掉 enforce 行：不再拦真实工具调用，但落账判定仍在（判定是核心，不是执行面）。
- 四行共享一个 `ctx.provide('neuralWorkflow', …)` 服务；component 之间不互相 import 内部单例。

### P2 clearAI 三条
- 不变量：若宿主挂了 `invariants` 服务，C1–C6 以包名注册进去；没挂则零成本跳过（不抛）。
- 失败可入账：新增 `kind:"failure"` 通道——失败事实必须能落账，但**不得**满足任何节点（失败不是证据）。
- 词表：`lib/vocab.js` 校验 `kind`/`node`，未知值报 `UNKNOWN_KIND`/`UNKNOWN_NODE` 并给出候选；不再靠裸字符串静默不匹配。

### P3 经验生命周期
- 存储：`$DSH_HOME/neural-workflow/projects/<projectKey>/experience.ndjson`（追加写，崩溃安全）。
- 记录字段：`id, title, body, kind(lesson|negative|idea), scope{conditions,ranges,units}, anchors[], standing(candidate|derived|canonical), createdAt, applications[], sourceEvent`。
- 升格：`candidate → derived` 需 ≥2 次成功应用或人工；`canonical` **只能**人工 `promote(..., explicit:true)`。
- 反馈：`feedback(id, success|failure)` 记入 `applications`，失败使 standing 降一级（canonical 只记历史）。
- 矛盾：同 scope 且标题高相似但结论相反 → 两方都可见，`contradictions()` 列出，不自动合并。
- 复发：同一根因跨 ≥3 条记录 → `recurrence()` 返回聚类。
- 全部纯函数 + 一个薄 IO 层，测试覆盖：升格门槛、失败降级、矛盾不自动消解、复发阈值。

### P4 执行器
- 输入：Rust 判定（frontier/blocked/violations）+ 预算 + 经验条目。
- 输出：`planStep()` 给出本轮该做哪个节点、带哪些经验、该跑哪些门禁命令。
- `runStage()` 通过 `ctx.subagents.startActivation` 起一个阶段子代理，**一次一阶段**，不写死循环。
- 停机：`maxStages`、`maxWallMs`、`maxConsecutiveNoProgress` 三条任一触发即 `stop`，并给出触发原因。
- 证据生产：`anchors` 路径必须真实存在才收（注入 `fs.exists` 依赖以便测试）；门禁命令执行结果记 `kind:"gate"`。
- 测试：预算三条各自触发、无进展计数、锚点不存在被拒。

### P5 原生件
- `scripts/build-native.mjs` 构建并把二进制放进 `runtime/<platform>-<arch>/`，同时写 `runtime/manifest.json`（版本、sha256、大小、平台）。
- 宿主解析顺序：配置 `binaryPath` → `runtime/<当前平台>/` → `lib/native/`（兼容）。
- `.gitignore` 仍忽略构建产物；`runtime/` 通过 release 附件分发，不进 git 主分支（避免二进制入库）。

## 执行顺序

1. Lead：P1 行拆分（结构先定，后面都挂在它上面）
2. 并行：Lead P0/P2；`exp-lifecycle` P3；`executor` P4
3. Lead：P5 → P6 集成（把 P3/P4 接进 tool、prompt、routes）
4. 验证：`npm run check` + `node --test` + 安装到 profile + 实例内实调

## 未做与原因

### P1 组件行拆分（core / panel / kb / enforce）

**没做**。原因：拆分要求把 `lib/index.js` 里已经验证在跑的投影、worker、工具、路由
搬到四个入口文件并用 `ctx.provide('neuralWorkflow')` 串起来。这一步的风险不在于写不出来，
而在于**会动到当前已验证工作的路径**（面板、工具、提示词段落），而它的收益只是
"可选开关"。在经验库与执行器刚接进来、还没跑过一轮真实会话的前提下，先做结构拆分
会让回归面变大。

做法（下一轮）：`lib/runtime.js` 提取 worker+投影+judge → `lib/index.js` 只留 core →
`lib/panel.js` 挂路由 → `lib/kb-host.js` 提供 kb 服务 → `lib/enforce.js` 挂
`tools.pre-execute` + `tools.guard`。做完要能证明"关掉 panel 行路由消失但工具仍工作"。

### P5 原生件分平台预置

**没做**。`scripts/build-native.mjs` + `runtime/<platform>-<arch>/` + 哈希回执还没写；
当前仍是 `bash native/build.sh` 就地构建、`lib/native/` 被 gitignore。
后果：克隆仓库后不构建二进制，面板是只读降级（已在 README 说明）。
