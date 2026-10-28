# dsh-neural-workflow

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](#) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](#)

A DeepSeek Harness plugin that puts the neural-network research workflow under **runtime constraint**: a stage graph, an evidence ledger folded from the session log, and a Rust middleware that blocks progress with no upstream evidence.

It is built from this repository's own skill (`skills/neural-paper-workflow/`), so the stages and gates in the graph are the ones the workflow actually enforces — not an invented checklist.

## What it does

| Surface | What you get |
| --- | --- |
| **Panel icon** (`sidebar.panellist`) | One entry beside Plugins / Automation / Context Insights; opens the full-page board. |
| **Board page** (`main`) | The stage graph with live node states, layer completion bars, the violation list, and the evidence ledger. |
| **Workflow tab** (`conversation.view`) | The same board bound to the current session, beside Chat / Trajectory / Context. |
| **`neural_flow` tool** | The model records evidence (`node` + `kind` + optional `anchors[].path`). The middleware validates *before* the record lands, so a rejected record comes back with the exact constraint that blocked it. |
| **Runtime context** | A `systemPrompt` section states the current frontier and open violations, so the model knows what is ready next. |

Nothing is written to your workspace: the ledger lives in the session log, so it survives restarts, resumes, and compaction.

## The six constraints

| Code | Rule |
| --- | --- |
| `C1` | **Reference integrity** — evidence may not point at a node the graph does not have. |
| `C2` | **Kind match** — a node only accepts the evidence kinds it declares. |
| `C3` | **Admission before advance** — evidence on a downstream node whose upstream is unsatisfied is out of order. |
| `C4` | **Traceability** — nodes that require anchors need `anchors[].path`. |
| `C5` | **Completion needs support** — a `completion` claim is refused while a mandatory node is still open. |
| `C6` | **Evidence completeness** — `kind` and `node` may not be empty. |

A constraint that cannot find its evidence stays silent: a criterion narrower than the facts would produce false positives.

## Install

```sh
# build the native middleware (optional — the panel degrades to read-only without it)
bash native/build.sh

# from the DSH profile
dsh plugin --profile desktop add /absolute/path/to/dsh-neural-workflow
```

Or install the directory through the Harness plugin manager (`install_bundle` with this package directory as the target).

## Layout

```
graph/neural-paper-workflow.json   the stage graph (data — edit this, not the code)
native/                            Rust middleware: the ONLY constraint interpreter
lib/index.js                       host half: projection, tool, prompt section, HTTP routes
lib/client.js                      browser half: sidebar entry, page, conversation view
lib/fold.js                        the single authoritative ledger fold (pure)
PROTOCOL.md                        the host ↔ middleware wire contract
```

## Design

Two lessons are copied deliberately, and one is deliberately avoided.

**From clearAI** — state has exactly one authority. `lib/fold.js` folds the session log; the projection, the tool, the panel and the prompt section all read that one fold. There is no second index to drift out of sync.

**From dsh-ops** — the native worker is a managed subprocess with a line protocol, honest provenance checks, and an explicit degraded mode. And the constraint judgement lives *only* in Rust: the host half never re-implements it in JS, because a second interpreter is guaranteed to diverge. When the binary is missing, the panel says so instead of silently substituting a different answer.

**From Veyra** — memory is evidence-anchored and reused across sessions rather than re-derived; here that surfaces as `anchors[].path` on evidence and a ledger that is durable by construction.

## Verify

```sh
node scripts/build.mjs --check   # graph is consistent and lib/graph-data.js is current
node scripts/check.mjs           # syntax, bundle shape, slot names, manifest
node --test tests/*.test.mjs     # fold determinism + middleware contract (16 tests)
```

## License

Apache-2.0. See [LICENSE](LICENSE).
