# dsh-neural-workflow

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](#) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](#)

[English](README.md) · **中文**

把神经网络科研工作流放进**运行时约束**里的 DeepSeek Harness 插件：一张阶段图、一本从会话日志折出来的证据账本，以及一个拦下"没有上游证据的推进"的 Rust 中间件。

阶段与门禁直接取自本项目自己的 skill（`skills/neural-paper-workflow/`），所以图里写的就是工作流真正在执行的规则，不是另编一张检查表。

## 它做什么

| 界面 | 你会得到什么 |
| --- | --- |
| **面板图标**（`sidebar.panellist`） | 与 插件 / 自动化任务 / 上下文洞察 并列的一个入口，点开整页看板。 |
| **看板页**（`main`） | 阶段图（节点状态实时）、层完成度条、违规清单、证据账本。 |
| **工作流标签页**（`conversation.view`） | 同一块看板绑定到当前会话，与 聊天 / 轨迹 / 上下文 并列。 |
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
lib/client.js                      浏览器半：侧栏入口、整页、会话视图
lib/fold.js                        唯一的权威折账（纯函数）
PROTOCOL.md                        宿主 ↔ 中间件线协议
```

## 设计取舍

两条正形照抄，一条反例刻意避开。

**学 clearAI** —— 状态只有一个权威。`lib/fold.js` 折会话日志；投影、工具、面板、提示词段落都读这一份折出来的状态，没有第二套索引可以漂移。

**学 dsh-ops** —— 原生 worker 是受管子进程，走行协议、带诚实的环境检查与显式降级。而约束判定**只在 Rust 里实现一份**：宿主半绝不重写一遍。因为第二套解释器必然漂移；二进制缺失时面板就直说缺了，而不是偷偷换一个答案顶上。

**学 Veyra** —— 记忆是证据锚定、跨会话复用的，而不是每次重新推导；在这里体现为证据必须带 `anchors[].path`，以及一本从构造上就持久化的账本。

## 验证

```sh
node scripts/build.mjs --check   # 图自洽、lib/graph-data.js 是最新的
node scripts/check.mjs           # 语法、bundle 形状、slot 名、manifest
node --test tests/*.test.mjs     # 折账确定性 + 中间件契约（17 项）
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
