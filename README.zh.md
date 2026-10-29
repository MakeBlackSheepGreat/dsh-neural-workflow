# dsh-neural-workflow

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](#) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](#)

[English](README.md) · **中文**

把神经网络科研工作流放进**运行时约束**里的 DeepSeek Harness 插件：一张阶段图、一本从会话日志折出来的证据账本，以及一个拦下"没有上游证据的推进"的 Rust 中间件。

阶段与门禁直接取自本项目自己的 skill（`skills/neural-paper-workflow/`），所以图里写的就是工作流真正在执行的规则，不是另编一张检查表。

## 功能

### 1. 阶段图与运行时判定

四个层、十个阶段，逐条取自 skill 的「阶段编排」：

```
L0 问题与设计   scope → develop
L1 执行         train → infer → validate
L2 证据与结论   conclude → write
L3 表达与交付   figure → polish → submit
```

每个节点声明证据种类、是否必须带锚点、以及取自 skill「质量门」的门禁描述。中间件按需计算：
每个节点的 `satisfied` / `ready` / `blocked`（并指出卡住它的上游）、每层完成度、
**前沿**（此刻能推进哪些阶段）、以及每条违规的约束编号与一句诊断。

### 2. 六条约束（C1–C6）

| 编号 | 规则 |
| --- | --- |
| `C1` | **引用完整性** —— 证据不能指向图里不存在的节点。 |
| `C2` | **种类匹配** —— 节点只接受它声明的证据种类。 |
| `C3` | **准入先于推进** —— 上游未满足就把证据落到下游，属于越序。 |
| `C4` | **可追溯** —— 要求锚点的节点，证据必须带 `anchors[].path`。 |
| `C5` | **终局有据** —— 必达节点未全绿时，`completion` 声明一律拒绝。 |
| `C6` | **证据完整** —— `kind` 与 `node` 都不许为空。 |

查不到判据的约束**保持沉默**：比事实更窄的判据只会制造误伤。

### 3. 证据账本

账本不是数据库，而是**会话日志的投影**。模型用 `neural_flow` 工具落证据，中间件在**落账之前**判定，
被拒时回填具体是哪条约束拦下的。通过的证据随工具结果写进日志，因此重启、续聊、上下文压缩之后仍然在，
也不会往聊天里塞假的用户消息。

### 4. 经验库（611 条）

整个 `skills/neural-paper-workflow/knowledge/graph` 在构建期编译进插件：

| 类型 | 条数 | 是什么 |
| --- | --- | --- |
| `idea` | 567 | idea / 实验配方：怎么做消融、校准、泄漏检查、画图 |
| `error` | 28 | 已知错误：根因、禁止项、验证命令 |
| `experiment` | 10 | 实验设计模式 |
| `perf`、`writing` | 6 | 性能与写作经验 |

两步检索，与 skill 自己的引擎同构：

1. `neural_flow` 的 `action: "knowledge", query: "<症状>"` → 打分后的命中 + 摘要
2. `action: "knowledge", entry: "NP002"` → 取全文（根因、做法、命令、禁止项）

打分刻意可解释：标题命中记 3，正文命中记 1，整短语出现在标题再 +2，最后按严重度乘权
（`critical` 3、`major` 2）。零分条目直接丢弃，不返回"看起来相关"的噪声。

### 5. 四个界面

位置与 dsh-context 完全对齐（同一批 slot、相邻 order）：

| 界面 | Slot | 内容 |
| --- | --- | --- |
| 侧栏图标 | `sidebar.panellist`（order 25） | 与 插件 / 自动化任务 / 上下文洞察 并列 |
| 整页看板 | `main` | 阶段图、层进度、违规、账本、经验检索 |
| 会话标签 | `conversation.view`（order 25） | 同一块看板绑定当前会话 |
| 右侧栏标签页 | `sidebar.right.pane.tab` + `.title` | 同一块看板跟在聊天旁边，从右栏的卡片打开 |

右侧栏入口走的是 dsh-context 用的同一条公开两步路径：`ctx.sidebarRightTabs.register({ id, kind, title, guide })`
声明 tab 类型，再由 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 用同一个 id 提供正文与页签标题。
宿主没有 `sidebarRightTabs` 时整段跳过，其余三个界面不受影响。

样式只吃主题 token（`--dsw-alias-*`），浅色深色都成立。排版按**容器**宽度而非视口宽度：
右侧栏在宽窗口里只有 300 多像素，`@media (max-width)` 在那里永远不触发。所以断点写成
`@container nwpanel`，图布用 `ResizeObserver` 量自己的容器，窄于 620px 时从「一层一列」
切成「一层一行」——节点卡保持满宽，不会塌成中文逐字换行。

### 5b. 图稿审计是工具，不是判断

`figure_audit` 跑项目里那五个确定性图稿检测器（结构、语义、几何、质量、渲染），
返回一份合并报告。它与 `neural_flow` 分开，因为**输入域不同**：
一个操作工作流状态，一个操作磁盘上的文件。

在它能诚实工作之前，有两种骗人的情形必须先处理掉——都是**跑出来的**，不是读代码看出来的：

| 检测器的实际行为 | 为什么会骗人 | 工具怎么做 |
| --- | --- | --- |
| 没有 draw.io CLI 时，`check_figure_rendering` 返回 `status=PASS, score=100`，所有检查标 `SKIP` | 一个什么都没检查的"通过" | 降级为 `SKIPPED` 并点名缺什么；不贡献任何 `PASS` 行 |
| `check_figure_geometry` / `check_figure_quality` 在**发现缺陷时**以退出码 1 结束，stdout 上的 JSON 完全有效 | 把非零退出当崩溃，会把最该看见的缺陷删掉 | 先解析 stdout；退出码只做逐项附注，不当判定 |

支持的格式按**实际能检查什么**如实声明：`.drawio` 五个全跑，`.pdf` 只跑几何里的
印刷字号下限，位图与 `.svg` 一个都跑不了（结构检查都要读 XML 模型）。
找不到检测器目录时报"没执行检查"，绝不报"没发现问题"。

### 6. 运行时上下文

一个 `systemPrompt` 段落陈述当前进度、前沿与未通过约束——模型不必被提醒就知道下一步能做什么。

## 界面总览

| 界面 | 你会得到什么 |
| --- | --- |
| **面板图标**（`sidebar.panellist`） | 与 插件 / 自动化任务 / 上下文洞察 并列的一个入口，点开整页看板。 |
| **看板页**（`main`） | 阶段图（节点状态实时）、层完成度条、违规清单、证据账本。 |
| **工作流标签页**（`conversation.view`） | 同一块看板绑定到当前会话，与 聊天 / 轨迹 / 上下文 并列。 |
| **右侧栏标签页**（`sidebar.right.pane.tab`） | 同一块看板跟在聊天右侧；从右栏的「添加工具」卡片里选「神经工作流」打开。窄宽度自动切成竖排，不会压扁卡片。 |
| **`neural_flow` 工具** | 模型用它在工作流上落证据（`node` + `kind` + 可选 `anchors[].path`）。中间件在**落账之前**判定，被拒时回填具体是哪条约束拦下的。 |
| **运行时上下文** | 一个 `systemPrompt` 段落陈述当前前沿与未通过的约束，模型由此知道下一步该做什么。 |

不往你的工作区写任何东西：账本存在会话日志里，因此重启、续聊、上下文压缩之后仍然在。

## 六条约束

| 编号 | 规则 |
| --- | --- |
| `C1` | **引用完整性** —— 证据不能指向图里不存在的节点。 |
| `C2` | **种类匹配** —— 节点只接受它声明的证据种类。 |
| `C3` | **准入先于推进** —— 上游未满足就把证据落到下游节点，属于越序。 |
| `C4` | **可追溯** —— 要求锚点的节点，证据必须带 `anchors[].path`。 |
| `C5` | **终局有据** —— 必达节点还没全绿时，`completion` 声明一律拒绝。 |
| `C6` | **证据完整** —— `kind` 与 `node` 都不许为空。 |

查不到判据的约束**保持沉默**：比事实更窄的判据只会制造误伤。

## 安装

```sh
# 构建原生中间件（可选——没有它面板会降级为只读，并说明原因）
bash native/build.sh

# 在 DSH profile 里安装
dsh plugin --profile desktop add /absolute/path/to/dsh-neural-workflow
```

或者用 Harness 的插件管理器装这个目录（对包目录调用 `install_bundle`）。

## 目录结构

```
graph/neural-paper-workflow.json   阶段图（数据——改这里，不改代码）
native/                            Rust 中间件：唯一的约束解释器
lib/index.js                       宿主半：投影、工具、提示词段落、HTTP 路由
lib/client.js                      浏览器半：侧栏图标、整页、会话视图、右侧栏页签、经验检索
lib/fold.js                        唯一的权威折账（纯函数）
lib/kb.js                          经验检索（纯函数，打分可解释）
scripts/build-kb.mjs               skill 知识图谱 → lib/kb-data.js + lib/kb-full.js
PROTOCOL.md                        宿主 ↔ 中间件线协议
```

## 设计取舍

两条正形照抄，一条反例刻意避开。

**学 clearAI** —— 状态只有一个权威。`lib/fold.js` 折会话日志；投影、工具、面板、提示词段落都读这一份折出来的状态，没有第二套索引可以漂移。

**学 dsh-ops** —— 原生 worker 是受管子进程，走行协议、带诚实的环境检查与显式降级。而约束判定**只在 Rust 里实现一份**：宿主半绝不重写一遍。因为第二套解释器必然漂移；二进制缺失时面板就直说缺了，而不是偷偷换一个答案顶上。

**学 Veyra** —— 记忆是证据锚定、跨会话复用的，而不是每次重新推导；在这里体现为证据必须带 `anchors[].path`，以及一本从构造上就持久化的账本。

## 验证

```sh
node scripts/build.mjs --check      # 图自洽、lib/graph-data.js 是最新的
node scripts/build-kb.mjs --check   # 经验索引与 skill 同步
node scripts/check.mjs              # 语法、bundle 形状、slot 名、manifest
node scripts/render-check.mjs       # 每个注册组件都能渲染且不抛错
node scripts/visual-check.mjs       # 真 CSS 进无头 Chrome：不裁切、卡片不被压扁
node --test tests/*.test.mjs        # 折账确定性、词表、执行器、经验生命周期、项目状态
```

`npm run check` 跑前五条，`npm test` 跑最后一条。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
