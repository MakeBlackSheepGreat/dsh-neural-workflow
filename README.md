# dsh-neural-workflow

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2)](#) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](#)

[中文](README.zh.md) · **English**

A DeepSeek Harness plugin that puts the neural-network research workflow under **runtime constraint**: a stage graph, an evidence ledger folded from the session log, a lesson library of 611 recorded experiences, and a Rust middleware that blocks progress with no upstream evidence.

Stages, gates and the lesson library come from this project's own skill (`skills/neural-paper-workflow/`), so what the graph enforces is what the workflow actually does — not an invented checklist.

## Features

### 1. Stage graph with runtime verdicts

Ten stages across four layers, derived from the skill's 阶段编排:

```
L0 问题与设计   scope → develop
L1 执行         train → infer → validate
L2 证据与结论   conclude → write
L3 表达与交付   figure → polish → submit
```

Every node declares evidence kinds, a required-anchor flag, and a gate description taken from the skill's 质量门. The middleware computes, on demand:

- `satisfied` / `ready` / `blocked` per node, with the blocking upstream nodes named
- per-layer completion
- the **frontier**: which stages may be worked on right now
- violations, each with its constraint code and a one-line diagnosis

### 2. Six constraints (C1–C6)

| Code | Rule |
| --- | --- |
| `C1` | **Reference integrity** — evidence may not point at a node the graph does not have. |
| `C2` | **Kind match** — a node only accepts the evidence kinds it declares. |
| `C3` | **Admission before advance** — evidence on a downstream node whose upstream is unsatisfied is out of order. |
| `C4` | **Traceability** — nodes that require anchors need `anchors[].path`. |
| `C5` | **Completion needs support** — a `completion` claim is refused while a mandatory node is still open. |
| `C6` | **Evidence completeness** — `kind` and `node` may not be empty. |

A constraint that cannot find its evidence stays silent: a criterion narrower than the facts would produce false positives.

### 3. Evidence ledger

The ledger is not a database — it is a **projection of the session log**. The model records evidence with the `neural_flow` tool; the middleware validates it *before* it lands, and a rejected record comes back with the exact constraint that blocked it. Accepted evidence rides on the tool result, so it survives restart, resume, and compaction, and never pollutes the chat transcript with synthetic user messages.

### 4. Lesson library (611 entries)

The whole `skills/neural-paper-workflow/knowledge/graph` is compiled into the plugin at build time:

| Kind | Count | What it is |
| --- | --- | --- |
| `idea` | 567 | Idea/experiment recipes: how to do ablation, calibration, leakage checks, figure work |
| `error` | 28 | Known errors with root cause, forbidden actions, and verification commands |
| `experiment` | 10 | Experiment design patterns |
| `perf`, `writing` | 6 | Performance and writing lessons |

Two-step retrieval, matching how the skill's own engine works:

1. `neural_flow` with `action: "knowledge", query: "<symptom>"` → scored matches with a gist
2. `action: "knowledge", entry: "NP002"` → full entry (root cause, approach, command, forbid list)

Scoring is deliberate and explainable: title hits weigh 3, body hits 1, full-phrase-in-title +2, multiplied by severity (`critical` 3, `major` 2). Zero-score entries are dropped rather than returned as "maybe relevant" noise.

### 5. Four UI surfaces

Placed exactly where dsh-context puts its own — same slots, adjacent order:

| Surface | Slot | What you get |
| --- | --- | --- |
| Sidebar icon | `sidebar.panellist` (order 25) | Entry beside Plugins / Automation / Context Insights |
| Board page | `main` | Stage graph, layer bars, violations, ledger, lesson search |
| Session tab | `conversation.view` (order 25) | The same board bound to the current session |
| Right sidebar tab | `sidebar.right.pane.tab` + `.title` | The same board beside the chat, opened from the right Sidebar's guide card |

The right sidebar entry registers through the same public two-stage path dsh-context uses:
`ctx.sidebarRightTabs.register({ id, kind, title, guide })` declares the tab type, then
`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` supply its body and chip under that
same id. A harness without `sidebarRightTabs` skips the block entirely; the other three
surfaces are unaffected.

Styling uses only theme tokens (`--dsw-alias-*`), so light and dark both work. Layout is
**container-driven, not viewport-driven**: the right sidebar is ~300px wide inside a wide
window, so `@media (max-width)` never fires there. Breakpoints are `@container nwpanel`,
the graph measures its own container through `ResizeObserver`, and below 620px it switches
from one-layer-per-column to one-layer-per-row so node cards keep the full width instead of
collapsing into per-character CJK wrapping.

### 6. Runtime context

A `systemPrompt` section states the current progress, the frontier, and any open violations — so the model knows what is ready next without being told.

### 7. Experience ledger with a trust ladder

Lessons learned while working are stored per project under `$DSH_HOME/neural-workflow/projects/<key>/experience.ndjson` — append-only, never inside your repository.

| Standing | How it is reached | Effect |
| --- | --- | --- |
| `candidate` | a new record | visible, but never auto-recalled into the prompt |
| `derived` | 2 successful applications, or a human promote | auto-recalled for its stage |
| `canonical` | **only** `promote(id, 'canonical', { explicit: true })` | project truth |

A failed application demotes `derived` back to `candidate`; canonical only keeps the history. Contradictory records stay visible side by side and are never auto-merged. `recurrence()` clusters the same root cause across records.

### 8. Vocabulary, not bare strings

`lib/vocab.js` validates `node` and `kind` against the graph and returns the nearest candidates on a typo (`hypothesys` → `hypothesis`). It only ever *rejects more*, never accepts something the middleware would reject — the judgement stays in Rust.

### 9. Failure admission

`kind: "failure"` records a failure that already happened. It is always admissible and never satisfies a node: failures are facts, not evidence.

### 10. Dispatch plan

`action: "plan"` picks the next stage from the verdict, attaches the matching lessons and the real gate commands (`check_leakage.py`, `calibration_gate.py`, …) from the skill, and stops with a reason when the frontier is empty or the budget is spent.

### 11. Contract baseline

`docs/schema-baseline.json` + `scripts/check-release.mjs` freeze the shapes others depend on — graph nodes/kinds, wire ops and error codes, evidence fields, accepted kinds — and fail the build when they drift.

### 11b. Figure audit as a tool, not a judgement

`figure_audit` runs the project's five deterministic figure checkers — structure,
semantics, geometry, quality, rendering — and returns one merged report. It is a
separate tool from `neural_flow` because the input domain is different: one
operates on workflow state, the other on a file on disk.

Two failure modes had to be handled before this could be honest, both found by
running the checkers rather than reading them:

| What the checker does | Why it lies | What the tool does |
| --- | --- | --- |
| `check_figure_rendering` with no draw.io CLI returns `status=PASS, score=100`, every check `SKIP` | A pass that inspected nothing | Downgrades to `SKIPPED` with the missing dependency named; contributes no `PASS` row |
| `check_figure_geometry` / `check_figure_quality` exit 1 *when they find defects*, with valid JSON on stdout | Treating a non-zero exit as a crash deletes the very defects you need to see | Parses stdout first; the exit code becomes a per-check annotation, not the verdict |

Formats are declared by what can actually be checked: `.drawio` gets all five,
`.pdf` gets geometry only (print-font floor), bitmaps and `.svg` get none because
every structural check needs the XML model. A missing checker directory is
reported as "no checks ran", never as "no problems found".

### 12. Read-only UI, tool-only operations

The panel **visualises**; it never mutates. There is no write route and no action
button: dispatch, evidence recording, feedback, promotion and claim linking all
go through the `neural_flow` tool, because they must pass the verdict, the budget
and the session identity — and all three live on the Agent side. The panel reads
the same verdict the tool produced, so it can never show a state that bypassed
the gate.

This is clearAI's discipline kept intact: a UI write entry would be a second path
around the invariant, and a second path is how invariants die.

## Architecture



```
graph/neural-paper-workflow.json   the stage graph (data — edit this, not the code)
native/                            Rust middleware: the ONLY constraint interpreter
lib/index.js                       host: projection, tool, prompt section, HTTP routes
lib/client.js                      browser: sidebar icon, page, session view, right-bar tab, lesson search
lib/fold.js                        the single authoritative ledger fold (pure)
lib/experience.js                  per-project experience ledger (trust ladder, feedback, recurrence)
lib/executor.js                    dispatch plan, budget stop conditions, anchor checks
lib/vocab.js                       node/kind vocabulary with typo candidates
lib/kb.js                          lesson retrieval (pure, explainable scoring)
scripts/build-kb.mjs               skills knowledge graph → lib/kb-data.js + lib/kb-full.js
PROTOCOL.md                        host ↔ middleware wire contract
```

Three design rules are copied deliberately, and one thing is avoided.

**From clearAI** — state has exactly one authority. `lib/fold.js` folds the session log; the projection, the tool, the panel and the prompt section all read that one fold. There is no second index to drift.

**From dsh-ops** — the native worker is a managed subprocess with a line protocol, an explicit `selftest`, and an honest degraded mode. And the constraint judgement lives *only* in Rust: the host never re-implements it in JS, because a second interpreter is guaranteed to diverge. When the binary is missing the panel says so instead of silently substituting a different answer.

**From Veyra** — knowledge is evidence-anchored and reused across sessions rather than re-derived. Here that shows up as `anchors[].path` on evidence, a ledger durable by construction, and a lesson library compiled from what earlier sessions already learned.

**Avoided** — no scoring heuristics pretending to be judgement. Every number the panel shows comes from either the Rust verdict or a deterministic fold.

## Install

```sh
# 1. build the lesson library from the skill (already committed, rerun when the skill changes)
node scripts/build-kb.mjs

# 2. build the native middleware (optional — the panel degrades to read-only without it)
bash native/build.sh

# 3. install into a profile
dsh plugin --profile desktop add /absolute/path/to/dsh-neural-workflow
```

## Verify

```sh
node scripts/build.mjs --check       # graph consistent, lib/graph-data.js current
node scripts/build-kb.mjs --check    # lesson index current with the skill
node scripts/check.mjs               # syntax, bundle shape, slot names, manifest
node scripts/render-check.mjs        # every registered component renders without throwing
node scripts/visual-check.mjs        # real CSS in headless Chrome: no clipping, no collapsed cards
node --test tests/*.test.mjs         # fold determinism, vocabulary, executor, experience, project state
```

`npm run check` runs the first five; `npm test` runs the last.

## License

Apache-2.0. See [LICENSE](LICENSE).
