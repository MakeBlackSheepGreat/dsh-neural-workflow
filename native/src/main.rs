//! nw-constrain — 神经网络工作流约束中间件。
//!
//! 契约见仓库根 `PROTOCOL.md`：逐行 JSON 请求/响应，无状态纯函数。
//! 判据只有六条（C1..C6），查不到判据时安静地不判——判据比事实窄就是误伤。
//!
//! 纪律：本文件是**唯一**的约束解释器。宿主半不重算，只落账与展示。

use std::io::{self, BufRead, Write};

use serde_json::{json, Map, Value};

const CODE_REF_UNKNOWN_NODE: &str = "C1";
const CODE_KIND_NOT_ACCEPTED: &str = "C2";
const CODE_OUT_OF_ORDER: &str = "C3";
const CODE_EVIDENCE_UNANCHORED: &str = "C4";
const CODE_UNSUPPORTED_COMPLETION: &str = "C5";
const CODE_EMPTY_EVIDENCE: &str = "C6";

fn as_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string()
}

fn as_bool(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
}

fn as_array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(|item| item.as_array())
        .map(|items| items.to_vec())
        .unwrap_or_default()
}

fn as_strings(value: &Value, key: &str) -> Vec<String> {
    as_array(value, key)
        .iter()
        .filter_map(|item| item.as_str())
        .map(|item| item.to_string())
        .collect()
}

struct Node {
    id: String,
    layer: String,
    order: i64,
    kinds: Vec<String>,
    requires_all: bool,
    requires_anchor: bool,
    required_for_completion: bool,
}

impl Node {
    fn from(value: &Value) -> Option<Node> {
        let id = as_str(value, "id");
        if id.is_empty() {
            return None;
        }
        let required_for = as_strings(value, "requiredFor");
        Some(Node {
            id,
            layer: as_str(value, "layer"),
            order: value.get("order").and_then(|item| item.as_i64()).unwrap_or(0),
            kinds: as_strings(value, "evidenceKinds"),
            requires_all: as_bool(value, "requiresAllKinds"),
            requires_anchor: as_bool(value, "requiresAnchor"),
            required_for_completion: required_for.iter().any(|item| item == "completion"),
        })
    }
}

/// 一个节点的累积状态。
#[derive(Default, Clone)]
struct Tally {
    kinds: Vec<String>,
    anchored: bool,
    count: usize,
}

impl Tally {
    fn has_kind(&self, kind: &str) -> bool {
        self.kinds.iter().any(|item| item == kind)
    }
}

fn satisfied(node: &Node, tally: &Tally) -> bool {
    if tally.count == 0 {
        return false;
    }
    if node.requires_anchor && !tally.anchored {
        return false;
    }
    if node.kinds.is_empty() {
        return true;
    }
    if node.requires_all {
        node.kinds.iter().all(|kind| tally.has_kind(kind))
    } else {
        node.kinds.iter().any(|kind| tally.has_kind(kind))
    }
}

struct Violation {
    code: &'static str,
    node: String,
    constraint: &'static str,
    message: String,
}

impl Violation {
    fn new(code: &'static str, node: &str, constraint: &'static str, message: String) -> Violation {
        Violation {
            code,
            node: node.to_string(),
            constraint,
            message,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "node": self.node,
            "constraint": self.constraint,
            "message": self.message,
        })
    }
}

/// 六条判据 + 拓扑状态。顺序是**时间序**：一条证据只能看到它之前落下的证据。
pub fn evaluate(graph: &Value, evidence: &[Value], now: &str) -> Value {
    let mut nodes: Vec<Node> = as_array(graph, "nodes")
        .iter()
        .filter_map(Node::from)
        .collect();
    let edges = as_array(graph, "edges");

    // 稳定顺序：层序 → 节点序，便于相邻层与 frontier 的展示可复现。
    nodes.sort_by(|left, right| {
        left.layer
            .cmp(&right.layer)
            .then(left.order.cmp(&right.order))
            .then(left.id.cmp(&right.id))
    });

    let mut predecessors: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for edge in &edges {
        let from = as_str(edge, "from");
        let to = as_str(edge, "to");
        let (Some(from_index), Some(to_index)) = (
            nodes.iter().position(|node| node.id == from),
            nodes.iter().position(|node| node.id == to),
        ) else {
            continue;
        };
        if !predecessors[to_index].contains(&from_index) {
            predecessors[to_index].push(from_index);
        }
    }

    let mut tallies: Vec<Tally> = vec![Tally::default(); nodes.len()];
    let mut violations: Vec<Violation> = Vec::new();

    // 时间序折账：缺 `at` 的证据排在后面，仍按原始顺序处理。
    let mut order: Vec<usize> = (0..evidence.len()).collect();
    order.sort_by(|left, right| {
        let left_at = as_str(&evidence[*left], "at");
        let right_at = as_str(&evidence[*right], "at");
        left_at.cmp(&right_at).then(left.cmp(right))
    });

    for index in order {
        let item = &evidence[index];
        let kind = as_str(item, "kind");
        let node_id = as_str(item, "node");
        let label = if node_id.is_empty() {
            "(空节点)".to_string()
        } else {
            node_id.clone()
        };

        // C6：kind / node 为空——这条证据本身没有意义。
        if kind.is_empty() || node_id.is_empty() {
            violations.push(Violation::new(
                CODE_EMPTY_EVIDENCE,
                &label,
                "C6",
                format!("证据 {} 缺少 kind 或 node，无法入账", as_str(item, "id")),
            ));
            continue;
        }

        // C1：引用完整性——不能指向图里没有的节点。
        let Some(target) = nodes.iter().position(|node| node.id == node_id) else {
            violations.push(Violation::new(
                CODE_REF_UNKNOWN_NODE,
                &label,
                "C1",
                format!("证据 {} 指向图中不存在的节点 {node_id}", as_str(item, "id")),
            ));
            continue;
        };
        let node = &nodes[target];

        // C2：节点只接受它声明的证据种类。
        if !node.kinds.is_empty() && !node.kinds.iter().any(|item| item == &kind) {
            violations.push(Violation::new(
                CODE_KIND_NOT_ACCEPTED,
                &label,
                "C2",
                format!(
                    "证据 {} 的种类 {kind} 不被节点 {node_id} 接受（需 {:?}）",
                    as_str(item, "id"),
                    node.kinds
                ),
            ));
            continue;
        }

        // C3：准入先于推进——上游未满足就落下游证据即越序。
        let blocked_by: Vec<String> = predecessors[target]
            .iter()
            .filter(|predecessor| !satisfied(&nodes[**predecessor], &tallies[**predecessor]))
            .map(|predecessor| nodes[*predecessor].id.clone())
            .collect();
        if !blocked_by.is_empty() {
            violations.push(Violation::new(
                CODE_OUT_OF_ORDER,
                &label,
                "C3",
                format!(
                    "证据 {} 落在节点 {node_id}，但上游 {:?} 尚未满足（越序推进）",
                    as_str(item, "id"),
                    blocked_by
                ),
            ));
            continue;
        }

        // C4：可追溯性——节点要求路径锚点时，证据必须带 anchors[].path。
        let anchored = as_array(item, "anchors")
            .iter()
            .any(|anchor| !as_str(anchor, "path").trim().is_empty());
        if node.requires_anchor && !anchored {
            violations.push(Violation::new(
                CODE_EVIDENCE_UNANCHORED,
                &label,
                "C4",
                format!(
                    "证据 {} 落在要求锚点的节点 {node_id}，但没有 anchors[].path",
                    as_str(item, "id")
                ),
            ));
            continue;
        }

        // C5：终局声明必须等必达节点全绿。诊断里要带"此刻真正空着的必达节点"：
        // 只报当前节点不够——终局声明常常落在别的节点上（写在 writing 上、卡的是 experiment）。
        if kind == "completion" {
            let missing: Vec<String> = nodes
                .iter()
                .enumerate()
                .filter(|(position, node)| {
                    node.required_for_completion && !satisfied(node, &tallies[*position])
                })
                .map(|(_, node)| node.id.clone())
                .collect();
            if !missing.is_empty() {
                violations.push(Violation::new(
                    CODE_UNSUPPORTED_COMPLETION,
                    &label,
                    "C5",
                    format!("终局声明被拒：必达节点 {:?} 尚未满足", missing),
                ));
                continue;
            }
        }

        // 通过五道门，才入账。
        let tally = &mut tallies[target];
        tally.count += 1;
        tally.anchored = tally.anchored || anchored;
        if !tally.has_kind(&kind) {
            tally.kinds.push(kind);
        }
    }

    // 终态：satisfied / ready（上游全绿、自己未绿）/ blocked。
    let states: Vec<bool> = nodes
        .iter()
        .enumerate()
        .map(|(position, node)| satisfied(node, &tallies[position]))
        .collect();

    let mut node_view = Map::new();
    let mut frontier: Vec<String> = Vec::new();
    for (position, node) in nodes.iter().enumerate() {
        let blockers: Vec<String> = predecessors[position]
            .iter()
            .filter(|predecessor| !states[**predecessor])
            .map(|predecessor| nodes[*predecessor].id.clone())
            .collect();
        let state = if states[position] {
            "satisfied"
        } else if blockers.is_empty() {
            frontier.push(node.id.clone());
            "ready"
        } else {
            "blocked"
        };
        node_view.insert(
            node.id.clone(),
            json!({
                "state": state,
                "kinds": tallies[position].kinds.clone(),
                "anchored": tallies[position].anchored,
                "evidence": tallies[position].count,
                "blockedBy": blockers,
            }),
        );
    }

    // 层汇总，按图里声明的层序输出。
    let mut layer_order: Vec<String> = as_array(graph, "layers")
        .iter()
        .map(|layer| as_str(layer, "id"))
        .filter(|id| !id.is_empty())
        .collect();
    for node in &nodes {
        if !node.layer.is_empty() && !layer_order.contains(&node.layer) {
            layer_order.push(node.layer.clone());
        }
    }
    let layers: Vec<Value> = layer_order
        .iter()
        .map(|layer_id| {
            let mut total = 0usize;
            let mut green = 0usize;
            for (position, node) in nodes.iter().enumerate() {
                if &node.layer != layer_id {
                    continue;
                }
                total += 1;
                if states[position] {
                    green += 1;
                }
            }
            json!({ "id": layer_id, "satisfied": green, "total": total })
        })
        .collect();

    let satisfied_total = states.iter().filter(|state| **state).count();
    let violations_json: Vec<Value> = violations.iter().map(Violation::to_json).collect();

    json!({
        "ok": violations.is_empty(),
        "graph": as_str(graph, "id"),
        "evaluatedAt": now,
        "nodes": Value::Object(node_view),
        "layers": layers,
        "violations": violations_json,
        "frontier": frontier,
        "progress": { "satisfied": satisfied_total, "total": nodes.len() },
        "degraded": false,
    })
}

fn graph_fixture() -> Value {
    // 两条并行分支：ingest → conceive（必达），ingest → ship（终局）。
    // 这样 C5 才能单独被判：ship 的上游（ingest）已满足，而另一条分支的必达节点没绿。
    json!({
        "id": "fixture",
        "layers": [{ "id": "L0" }, { "id": "L1" }, { "id": "L2" }],
        "nodes": [
            { "id": "ingest", "layer": "L0", "order": 10, "evidenceKinds": ["corpus"], "requiresAnchor": true },
            { "id": "conceive", "layer": "L1", "order": 10, "evidenceKinds": ["note"], "requiredFor": ["completion"] },
            { "id": "ship", "layer": "L2", "order": 10, "evidenceKinds": ["completion"] }
        ],
        "edges": [
            { "from": "ingest", "to": "conceive" },
            { "from": "ingest", "to": "ship" }
        ]
    })
}

/// 内置断言：`op:"selftest"` 用它证明二进制与契约一致。
pub fn selftest() -> Value {
    let graph = graph_fixture();
    let mut failed: Vec<String> = Vec::new();
    let mut checks = 0usize;

    let mut check = |name: &str, condition: bool| {
        checks += 1;
        if !condition {
            failed.push(name.to_string());
        }
    };

    let empty = evaluate(&graph, &[], "t");
    check("空账本无违规", empty["ok"] == json!(true));
    check("空账本 frontier 是首层", empty["frontier"] == json!(["ingest"]));

    let unknown = evaluate(
        &graph,
        &[json!({ "id": "e1", "node": "nope", "kind": "corpus" })],
        "t",
    );
    check(
        "C1 未知节点被拒",
        unknown["violations"][0]["code"] == json!(CODE_REF_UNKNOWN_NODE),
    );

    let wrong_kind = evaluate(
        &graph,
        &[json!({ "id": "e1", "node": "ingest", "kind": "note" })],
        "t",
    );
    check(
        "C2 非法种类被拒",
        wrong_kind["violations"][0]["code"] == json!(CODE_KIND_NOT_ACCEPTED),
    );

    let out_of_order = evaluate(
        &graph,
        &[json!({ "id": "e1", "node": "conceive", "kind": "note", "at": "2026-01-01T00:00:00Z" })],
        "t",
    );
    check(
        "C3 越序被拒",
        out_of_order["violations"][0]["code"] == json!(CODE_OUT_OF_ORDER),
    );

    let unanchored = evaluate(
        &graph,
        &[json!({ "id": "e1", "node": "ingest", "kind": "corpus" })],
        "t",
    );
    check(
        "C4 无锚点被拒",
        unanchored["violations"][0]["code"] == json!(CODE_EVIDENCE_UNANCHORED),
    );

    // ship 的上游 ingest 已满足，所以这里命中的是 C5（必达节点 conceive 还空着），不是 C3。
    let early_completion = evaluate(
        &graph,
        &[
            json!({ "id": "e0", "node": "ingest", "kind": "corpus", "at": "2026-01-01T00:00:00Z",
                    "anchors": [{ "path": "data/corpus/" }] }),
            json!({ "id": "e1", "node": "ship", "kind": "completion", "at": "2026-01-02T00:00:00Z" }),
        ],
        "t",
    );
    check(
        "C5 无支撑终局被拒",
        early_completion["violations"][0]["code"] == json!(CODE_UNSUPPORTED_COMPLETION),
    );

    let empty_evidence = evaluate(&graph, &[json!({ "id": "e1", "kind": "note" })], "t");
    check(
        "C6 空证据被拒",
        empty_evidence["violations"][0]["code"] == json!(CODE_EMPTY_EVIDENCE),
    );

    let happy = evaluate(
        &graph,
        &[
            json!({ "id": "e1", "node": "ingest", "kind": "corpus", "at": "2026-01-01T00:00:00Z",
                    "anchors": [{ "path": "data/corpus/" }] }),
            json!({ "id": "e2", "node": "conceive", "kind": "note", "at": "2026-01-02T00:00:00Z" }),
            json!({ "id": "e3", "node": "ship", "kind": "completion", "at": "2026-01-03T00:00:00Z" }),
        ],
        "t",
    );
    check("合法链路无违规", happy["ok"] == json!(true));
    check(
        "合法链路全绿",
        happy["progress"]["satisfied"] == happy["progress"]["total"],
    );

    json!({ "checks": checks, "failed": failed })
}

fn respond_error(id: &str, code: &str, message: &str) -> String {
    json!({ "id": id, "ok": false, "error": { "code": code, "message": message } }).to_string()
}

fn dispatch(line: &str) -> String {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return respond_error("", "E_JSON", &format!("请求不是合法 JSON：{error}"));
        }
    };
    let id = as_str(&request, "id");
    let op = as_str(&request, "op");
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));

    match op.as_str() {
        "evaluate" => {
            // `graph` 必须是对象：缺字段、null、字符串都不是"一张空图"，而是调用方写错了。
            // 把 null 当空图放过去，会让判定静默变绿——这正是最坏的一种"看起来通过"。
            let Some(graph) = input.get("graph").filter(|value| value.is_object()) else {
                return respond_error(&id, "E_INPUT", "evaluate 需要 input.graph 为对象");
            };
            let evidence = as_array(&input, "evidence");
            let now = as_str(&input, "now");
            let value = evaluate(graph, &evidence, &now);
            json!({ "id": id, "ok": true, "value": value }).to_string()
        }
        "selftest" => json!({ "id": id, "ok": true, "value": selftest() }).to_string(),
        "" => respond_error(&id, "E_OP", "缺少 op"),
        other => respond_error(&id, "E_OP", &format!("未知 op：{other}")),
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    // 启动即自检：契约不一致时在 stderr 说清楚，但继续服务（只读降级由宿主决定）。
    let report = selftest();
    if report["failed"]
        .as_array()
        .map(|items| !items.is_empty())
        .unwrap_or(true)
    {
        eprintln!("nw-constrain: selftest failed {report}");
    } else {
        eprintln!(
            "nw-constrain: ready ({} checks)",
            report["checks"].as_u64().unwrap_or(0)
        );
    }

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = dispatch(trimmed);
        if writeln!(out, "{response}").is_err() {
            break;
        }
        if out.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selftest_passes() {
        let report = selftest();
        assert_eq!(report["failed"], json!([]));
        assert!(report["checks"].as_u64().unwrap_or(0) >= 10);
    }

    #[test]
    fn unknown_op_is_reported() {
        let response: Value = serde_json::from_str(&dispatch(r#"{"id":"1","op":"nope"}"#)).unwrap();
        assert_eq!(response["ok"], json!(false));
        assert_eq!(response["error"]["code"], json!("E_OP"));
    }

    #[test]
    fn bad_json_does_not_crash() {
        let response: Value = serde_json::from_str(&dispatch("not json")).unwrap();
        assert_eq!(response["error"]["code"], json!("E_JSON"));
    }

    #[test]
    fn blocked_downstream_is_not_ready() {
        let graph = graph_fixture();
        let report = evaluate(&graph, &[], "t");
        assert_eq!(report["nodes"]["conceive"]["state"], json!("blocked"));
        assert_eq!(report["nodes"]["conceive"]["blockedBy"], json!(["ingest"]));
    }
}
