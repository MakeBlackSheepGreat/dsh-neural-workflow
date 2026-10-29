# 约束网络协议（host ↔ Rust 中间件）

本文件是**唯一契约**。宿主半（`lib/`）与原生中间件（`native/`，Rust）都只照本文件实现，
不各留一份"解释器"——clearAI 的教训是第二套解释器必然漂移。

## 1. 进程与传输

- 一个常驻子进程，`stdin` 逐行读、`stdout` 逐行写；**一行一个 JSON**，无 BOM，UTF-8。
- 请求：`{"id": <string>, "op": <string>, "input": <object>}`
- 响应：`{"id": <same>, "ok": true, "value": <object>}` 或 `{"id": <same>, "ok": false, "error": {"code": <string>, "message": <string>}}`
- 未知 `op` → `ok:false`，`code:"E_OP"`。坏 JSON → `ok:false`，`code:"E_JSON"`（进程不退出）。
- 进程只在宿主 `effect` 销毁时关闭；每次请求无状态（状态由宿主落账，中间件是纯函数）。

## 2. 图（graph）

```jsonc
{
  "id": "neural-paper-workflow",
  "version": 1,
  "layers": [{ "id": "L0", "order": 0, "name": { "zh": "…", "en": "…" } }],
  "nodes": [{
    "id": "ingest",
    "layer": "L0",
    "order": 10,
    "name": { "zh": "…", "en": "…" },
    "evidenceKinds": ["corpus", "note"],   // 该节点接受的证据种类
    "requiresAllKinds": false,             // true = 列出的种类全部到齐才算满足
    "requiresAnchor": true,                // true = 证据必须带 anchors[].path
    "requiredFor": ["completion"]          // "completion" 时，终局声明必须先满足本节点
  }],
  "edges": [{ "from": "ingest", "to": "conception", "port": "data" }]
}
```

边即数据依赖：`from` 必须**先满足**，`to` 才能进入 `ready`。

## 3. 账本（evidence）

```jsonc
{ "k": "evidence", "id": "ev-…", "node": "ingest", "kind": "corpus",
  "at": "2026-10-28T00:00:00.000Z", "note": "…",
  "anchors": [{ "path": "data/corpus/", "note": "…" }] }
```

`id` 在同一项目内唯一；重复 id 由宿主折账时丢弃后者（`DUP_ID`，不进中间件）。

## 4. `op: "evaluate"`

`input`: `{ "graph": <graph>, "evidence": [<evidence>...], "now": <iso 可选> }`

`value`:

```jsonc
{
  "ok": true,
  "nodes": { "ingest": { "state": "satisfied", "kinds": ["corpus"], "anchored": true } },
  "layers": [{ "id": "L0", "satisfied": 2, "total": 3 }],
  "violations": [{ "code": "OUT_OF_ORDER", "node": "writing", "constraint": "C3", "message": "…" }],
  "frontier": ["conception"],
  "progress": { "satisfied": 2, "total": 12 },
  "degraded": false
}
```

节点 `state`：`satisfied` / `ready`（上游全满足、自己未满足）/ `blocked`（上游未满足）。

## 5. 六条约束（中间件只判这六条，不判判断）

| code | 判据 |
| --- | --- |
| `C1` `REF_UNKNOWN_NODE` | 证据指向图里不存在的节点 |
| `C2` `KIND_NOT_ACCEPTED` | 证据种类不在该节点 `evidenceKinds` 内 |
| `C3` `OUT_OF_ORDER` | 证据落在"上游未满足"的节点上（准入先于推进） |
| `C4` `EVIDENCE_UNANCHORED` | 节点 `requiresAnchor` 但证据无 `anchors[].path` |
| `C5` `UNSUPPORTED_COMPLETION` | `kind:"completion"` 的证据在 `requiredFor:["completion"]` 节点未全满足时落下 |
| `C6` `EMPTY_EVIDENCE` | `kind` 或 `node` 为空 |

约束查不到判据时**安静地不判**（查不到 ≠ 不存在）。

## 6. `op: "selftest"`

`value`: `{ "checks": <n>, "failed": [] }`。无输入，跑内置断言。

## 7. 退出与降级

- 二进制缺失 → 宿主报 `degraded`，**不**用 JS 重算（避免第二套解释器），面板显示只读并说明原因。
- 子进程崩溃 → 宿主标记 `degraded` 并记录一次，下次请求重启一次。

## 8. 审计事实：`kind: "failure"`

失败是**事实**。拦下"已经发生的失败"等于要求只允许好看的事实进入账本——那本身才是不实陈述。

因此 `kind:"failure"` 走一条单独通道：

| 判据 | 是否适用 |
| --- | --- |
| `C1` 引用完整性 | **适用**（节点必须存在） |
| `C6` 证据完整 | **适用**（`kind`/`node` 非空） |
| `C2` 种类匹配 | 跳过（任何节点都接受失败） |
| `C3` 准入先于推进 | 跳过（一次失败的实验不会因为"顺序不对"就没发生） |
| `C4` 锚点 | 跳过 |
| `C5` 终局有据 | 跳过（失败不是完成声明） |

它**不增加满足度**：节点不会因为失败变绿。输出里每个节点多一个 `failures` 计数，与 `evidence` 分开。

```
{"id":"e1","node":"train","kind":"failure","note":"OOM at step 1200"}
→ {"ok":true,"nodes":{"train":{"state":"blocked","evidence":0,"failures":1}}}
```


## 9. 读面与写面

**HTTP 路由全部只读**（`graph` / `state` / `knowledge` / `experience` / `plan` /
`selftest`）——它们只回答"现在是什么"，不改变任何状态。

所有改变状态的操作只在工具 `neural_flow` 上（`record` / `experience` /
`state` / `run`），因为它们必须携带会话身份、过预算、过判定。面板是这同一份
判定的渲染，不存在旁路。
