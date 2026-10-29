/* dsh-neural-workflow — 浏览器半。
 *
 * 位置学 dsh-context：同一个面板 id 同时占三处——`sidebar.panellist`（一级面板图标）、
 * `main`（整页面板）、`conversation.view`（会话视图标签）。样式也学它：只吃主题 token
 * （--dsw-alias-*），不写死颜色，浅色/深色自动跟随。
 *
 * 数据两路：近期窗口走投影 `useProjection('neuralWorkflow')`（免轮询、自带变更通知）；
 * 全量账本 + 约束判定走 `/api/neural-workflow/state`（判定只能由 Rust 中间件出）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-neural-workflow',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const { useEffect, useMemo, useRef, useState } = react

    const NS = 'neural-workflow'
    const PANEL_ID = 'neural-workflow'
    const API = 'api/neural-workflow'

    const zh = {
      panel: '神经工作流',
      view: '工作流',
      title: '神经网络工作流',
      subtitle: '阶段约束 · 证据账本 · 越序拦截',
      progress: '进度',
      frontier: '当前可推进',
      violations: '未通过约束',
      noViolations: '暂无违规',
      ledger: '证据账本',
      emptyLedger: '还没有证据。用 neural_flow 工具落第一条。',
      satisfied: '已满足',
      ready: '可推进',
      blocked: '被上游阻塞',
      degraded: '中间件不可用，面板只读',
      degradedHint: '运行 native/build.sh 生成 nw-constrain，然后重启宿主。',
      refresh: '刷新',
      selftest: '自检',
      selftestOk: '二进制与契约一致',
      selftestFail: '自检失败',
      layers: '阶段层',
      evidence: '条证据',
      blockedBy: '阻塞于',
      anchors: '锚点',
      openPanel: '打开面板',
      knowledge: '经验库',
      knowledgePlaceholder: '症状或问题，如「AUC=1.0」「怎么做消融」',
      knowledgeHint: '搜一搜：611 条沉淀经验（错误/方法/idea 配方）。',
      knowledgeNone: '没有命中。换一个症状词。',
      search: '检索',
      why: '根因',
      fix: '做法',
      command: '命令',
      forbid: '禁止',
      close: '收起',
      dualGate: '双门',
      searchFailed: '检索失败',
      requestFailed: '请求失败',
      entryFailed: '取全文失败',
      panelHint: '只读视图。所有操作通过工具 neural_flow 完成（status / record / knowledge / experience / state / plan / run）。',
      guideDescription: '阶段约束、证据账本与越序拦截，跟在聊天旁边看',
      stages: '个阶段',
      expandAll: '全部展开',
      collapseAll: '全部收起',
      collapse: '收起',
      gate: '门',
      gateCommands: '校验命令',
      needsAnchor: '需要锚点',
      noAnchor: '无需锚点',
      anchor: '锚点',
      viewList: '列表',
      viewGraph: '图',
      runs: '阶段运行',
      runsNone: '还没有派发过阶段。用 neural_flow 的 run 动作派发。',
      runsUnavailable: '运行登记不可用',
      runOk: '完成',
      runFailed: '失败',
      runRunning: '运行中',
    }
    const en = {
      panel: 'Neural flow',
      view: 'Workflow',
      title: 'Neural workflow',
      subtitle: 'Stage constraints · evidence ledger · out-of-order blocking',
      progress: 'Progress',
      frontier: 'Ready now',
      violations: 'Violations',
      noViolations: 'No violations',
      ledger: 'Evidence ledger',
      emptyLedger: 'No evidence yet. Record the first one with the neural_flow tool.',
      satisfied: 'Satisfied',
      ready: 'Ready',
      blocked: 'Blocked upstream',
      degraded: 'Middleware unavailable — read-only',
      degradedHint: 'Run native/build.sh to build nw-constrain, then restart the host.',
      refresh: 'Refresh',
      selftest: 'Self-test',
      selftestOk: 'Binary matches the contract',
      selftestFail: 'Self-test failed',
      layers: 'Stage layers',
      evidence: 'evidence',
      blockedBy: 'blocked by',
      anchors: 'anchors',
      openPanel: 'Open panel',
      knowledge: 'Lesson library',
      knowledgePlaceholder: 'A symptom or question, e.g. "AUC=1.0"',
      knowledgeHint: 'Search 611 recorded lessons (errors, methods, idea recipes). Entries are authored in Chinese and shown verbatim.',
      knowledgeNone: 'No match. Try another symptom word.',
      search: 'Search',
      why: 'Root cause',
      fix: 'Approach',
      command: 'Command',
      forbid: 'Forbidden',
      close: 'Collapse',
      dualGate: 'dual gate',
      searchFailed: 'Search failed',
      requestFailed: 'Request failed',
      entryFailed: 'Could not load the entry',
      panelHint: 'Read-only view. Every operation goes through the neural_flow tool (status / record / knowledge / experience / state / plan / run).',
      guideDescription: 'Stage constraints, evidence ledger and out-of-order blocking, beside the chat',
      stages: 'stages',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      collapse: 'Collapse',
      gate: 'Gate',
      gateCommands: 'Gate commands',
      needsAnchor: 'needs anchors',
      noAnchor: 'no anchors',
      anchor: 'anchors',
      viewList: 'List',
      viewGraph: 'Graph',
      runs: 'Stage runs',
      runsNone: 'No stage dispatched yet. Dispatch one with the neural_flow run action.',
      runsUnavailable: 'Run registry unavailable',
      runOk: 'done',
      runFailed: 'failed',
      runRunning: 'running',
    }

    const CSS = `
.nw-panel{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;container:nwpanel/inline-size;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px}
.nw-scroll{flex:auto;min-height:0;overflow-y:auto;scrollbar-gutter:stable}
.nw-inner{padding:22px clamp(12px,2.4cqi,30px) 40px}
.nw-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:4px}
.nw-h1{margin:0;font-size:20px;font-weight:500;line-height:28px;letter-spacing:.01em}
.nw-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:2px 0 18px}
.nw-headctl{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nw-btn{font:inherit;cursor:pointer;border-radius:999px;padding:3px 12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);white-space:nowrap;transition:color .2s ease,border-color .2s ease,background-color .2s ease}
.nw-btn:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.nw-btn:disabled{opacity:.5;cursor:default}
.nw-warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c98a00) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c98a00) 10%,transparent);color:var(--dsw-alias-state-warn-primary,#8a5f00);border-radius:10px;padding:9px 12px;margin-bottom:14px;font-size:12px;line-height:1.55}
.nw-warn b{font-weight:650}
.nw-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px}
/* 断点必须问**容器**，不能问视口：右侧栏里视口是宽的、面板只有 320px，
   @media 永远不触发，于是 1fr 那一列被挤成 0，卡片就被压成竖排单字。 */
@container nwpanel (max-width:900px){.nw-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* 300px 左右仍保持两列：单个 KPI 只要放得下标签和数字，竖排四行反而更浪费屏幕。 */
@container nwpanel (max-width:260px){.nw-kpis{grid-template-columns:minmax(0,1fr)}}
@container nwpanel (max-width:420px){.nw-h1{font-size:17px;line-height:24px}.nw-inner{padding-top:16px}.nw-card{padding:10px 11px}.nw-sub{margin-bottom:12px}}
.nw-kpi{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:9px 11px;min-width:0}
.nw-kpi-k{color:var(--dsw-alias-label-secondary);font-size:10.5px;letter-spacing:.02em;text-transform:uppercase}
.nw-kpi-v{font-size:20px;font-variant-numeric:tabular-nums;line-height:1.35}
.nw-kpi-s{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,320px);gap:12px;align-items:start}
/* 网格子项必须能收缩。少了这一行，图布的固定像素宽度会成为整列的 min-content，
   1fr 被顶宽、整页横向溢出——这正是"图布看不见、页面被裁"的成因。 */
.nw-grid>*{min-width:0}
/* 同理：窄容器下单列，而不是把主列压成 0 再让节点卡互相叠。 */
@container nwpanel (max-width:860px){.nw-grid{grid-template-columns:minmax(0,1fr)}}
.nw-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px 14px;min-width:0;overflow:hidden}
.nw-card+.nw-card{margin-top:10px}
.nw-card-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.nw-card-t{margin:0;font-size:13px;font-weight:650}
.nw-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:1px 8px}
.nw-canvas-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
/* 列表视图：任务管理那种"一行一阶段、状态在右、点开看详情"的读法。
   与图视图读同一份判定，不是第二套数据。 */
.nw-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.nw-run{display:flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:5px 8px;min-width:0;font-size:11.5px}
.nw-run-node{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-run-time{color:var(--dsw-alias-label-secondary);font-size:10px;margin-left:auto;flex:none;font-variant-numeric:tabular-nums}
.nw-list{display:flex;flex-direction:column;gap:12px;min-width:0}
.nw-list-group{display:flex;flex-direction:column;gap:4px;min-width:0}
.nw-list-head{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650;letter-spacing:.02em;padding:0 2px}
.nw-list-layer{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.nw-list-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-list-row{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;min-width:0}
.nw-list-row[data-state=satisfied]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 7%,var(--dsw-alias-bg-layer-2))}
.nw-list-row[data-state=ready]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 55%,transparent)}
.nw-list-row[data-state=blocked]{opacity:.75}
.nw-list-hit{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;text-align:left;color:inherit;background:0 0;border:0;cursor:pointer;min-width:0}
.nw-list-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:auto}
.nw-list-title{font-size:12.5px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-list-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:5px;flex-wrap:wrap;overflow:hidden}
.nw-list-body{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px}
.nw-badge[data-state=satisfied]{color:var(--dsw-alias-state-success-primary,#1a9c5b);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 10%,transparent)}
.nw-badge[data-state=ready]{color:var(--dsw-alias-brand-primary,#3b6cf0);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 10%,transparent)}
.nw-badge[data-state=blocked]{color:var(--dsw-alias-label-secondary)}
.nw-canvas-tools{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.nw-canvas-note{color:var(--dsw-alias-label-secondary);font-size:11px;margin-right:auto;font-variant-numeric:tabular-nums}
.nw-link{font:inherit;font-size:11px;cursor:pointer;background:0 0;border:0;padding:0;color:var(--dsw-alias-brand-primary,#3b6cf0);white-space:nowrap}
.nw-link:hover{text-decoration:underline}
.nw-canvas-scroll{overflow-x:auto;overflow-y:hidden;min-width:0;scrollbar-gutter:stable}
.nw-canvas{position:relative;margin:0 auto}
.nw-canvas-layer{position:absolute;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100% - 20px)}
.nw-edges{position:absolute;inset:0;pointer-events:none;overflow:visible}
/* 宽度与高度都由布局函数经 inline style 给出：CSS 里再写死一个数字，
   两处不一致时绝对定位的卡片会比布局假定的窄/宽，边缘与连线就错位。 */
.nw-node{position:absolute;box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;overflow:hidden;transition:border-color .2s ease,box-shadow .2s ease}
.nw-node-hit{display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;text-align:left;color:inherit;background:0 0;border:0;cursor:pointer;flex:none}
.nw-node-kicker{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10px;flex:none}
.nw-node-name{font-size:12.5px;font-weight:650;line-height:1.35;overflow-wrap:break-word;word-break:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nw-node-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.nw-node-kinds{display:flex;flex-wrap:wrap;gap:3px;margin-top:1px}
.nw-kind{font-size:9.5px;line-height:14px;border-radius:4px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.nw-kind[data-got=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 45%,transparent);color:var(--dsw-alias-state-success-primary,#1a9c5b);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 10%,transparent)}
.nw-node-body{border-top:1px solid var(--dsw-alias-border-l1);padding:7px 10px 9px;display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto;flex:auto}
.nw-node-hint{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;overflow-wrap:anywhere}
.nw-node-gate,.nw-node-cmds{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:2px}
.nw-node-gate b,.nw-node-cmds b{color:var(--dsw-alias-label-primary);font-size:10px;letter-spacing:.02em}
.nw-node-cmds code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}
.nw-node-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:3px}
.nw-node-anchor{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:9.5px}
.nw-node-foot .nw-link{margin-left:auto}
.nw-node[data-state=satisfied]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9c5b) 8%,var(--dsw-alias-bg-layer-2))}
.nw-node[data-state=ready]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 28%,transparent)}
.nw-node[data-state=blocked]{opacity:.66}
.nw-node[data-open=true]{box-shadow:0 6px 18px -6px rgba(0,0,0,.28)}
.nw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.nw-dot[data-state=satisfied]{background:var(--dsw-alias-state-success-primary,#1a9c5b)}
.nw-dot[data-state=ready]{background:var(--dsw-alias-brand-primary,#3b6cf0)}
.nw-node-head{display:flex;align-items:center;gap:6px;min-width:0}
.nw-layer{margin-bottom:6px}
.nw-layer-k{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650;letter-spacing:.02em;margin:0 0 6px}
.nw-bar{height:5px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent);overflow:hidden;flex:auto;max-width:150px}
.nw-bar i{display:block;height:100%;background:var(--dsw-alias-state-success-primary,#1a9c5b);border-radius:3px}
.nw-bar-n{font-variant-numeric:tabular-nums}
.nw-vios{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.nw-vio{display:flex;gap:8px;align-items:flex-start;border-left:2px solid var(--dsw-alias-state-error-primary,#d92d48);padding:2px 0 2px 9px}
.nw-vio-code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10.5px;color:var(--dsw-alias-state-error-primary,#d92d48);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d48) 40%,transparent);border-radius:4px;padding:0 5px;flex:none;margin-top:1px}
.nw-vio-t{font-size:11.5px;line-height:1.5;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.nw-ok{color:var(--dsw-alias-state-success-primary,#1a9c5b);font-size:11.5px}
.nw-ledger{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.nw-ev{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:2px}
.nw-ev-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.nw-ev-kind{font-size:10.5px;border-radius:4px;padding:0 5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6cf0) 14%,transparent);color:var(--dsw-alias-brand-primary,#3b6cf0);flex:none}
.nw-ev-node{font-size:11.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-ev-time{color:var(--dsw-alias-label-secondary);font-size:10px;margin-left:auto;flex:none;font-variant-numeric:tabular-nums}
.nw-ev-note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.nw-ev-anchors{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:10px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);overflow-wrap:anywhere}
.nw-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}
.nw-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:11px}
.nw-legend-i{display:inline-flex;align-items:center;gap:5px}
.nw-icon{display:block}
.nw-title{display:inline-flex;align-items:center;gap:6px;min-width:0}
.nw-title-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nw-badge{font-size:9.5px;border-radius:4px;padding:0 4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:none}
.nw-badge-warn{color:var(--dsw-alias-state-warn-primary,#b7791f);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b7791f) 45%,transparent)}
.nw-search{display:flex;gap:6px;margin-bottom:8px}
.nw-input{flex:auto;min-width:0;font:inherit;font-size:12px;padding:5px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.nw-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b6cf0)}
.nw-kbs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.nw-kb{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:3px}
.nw-kb-btn{display:flex;align-items:baseline;gap:7px;font:inherit;text-align:left;background:0 0;border:0;padding:0;cursor:pointer;color:inherit;min-width:0}
.nw-kb-id{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:10.5px;color:var(--dsw-alias-brand-primary,#3b6cf0);flex:none}
.nw-kb-t{font-size:11.5px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.nw-kb-crit{font-size:9.5px;color:var(--dsw-alias-state-error-primary,#d92d48);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d48) 40%,transparent);border-radius:4px;padding:0 4px;flex:none}
.nw-kb-gist{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.nw-kb-detail{border-top:1px dashed var(--dsw-alias-border-l2);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:6px}
.nw-kb-detail-head{font-size:12px;font-weight:650;overflow-wrap:anywhere}
.nw-kb-row{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.nw-kb-row b{color:var(--dsw-alias-label-primary);margin-right:6px}
.nw-kb-row code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}
.nw-kb-forbid{margin:4px 0 0;padding-left:16px}
`

    /**
     * 当前界面语言：**以 DSH 的语言设置为准**（`locale.getLocale().active`）。
     *
     * 为什么不能只靠 `t()`：`t` 只管字典里的 UI 文案，而图数据（节点/层名、
     * hint、gate）是随图下发的双语对象，违规消息又来自 Rust 中间件（中文句子）。
     * 这三处都必须按同一个语言值挑选，否则就会出现"设置页英文、面板中文"。
     */
    function activeLang(ctx) {
      try {
        const locale = ctx.locale
        if (locale !== undefined && typeof locale.getLocale === 'function') {
          const current = locale.getLocale()
          if (current !== null && typeof current === 'object' && typeof current.active === 'string') {
            return current.active === 'zh' ? 'zh' : 'en'
          }
        }
      } catch {
        /* 拿不到就回退 en：宁可英文，也不要在英文界面里露中文 */
      }
      return 'en'
    }

    /** 从 `{zh, en}` 双语对象按当前语言取值；缺失时互相回退。 */
    function pickLocalized(value, lang) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value !== 'object') return String(value)
      const primary = lang === 'zh' ? value.zh : value.en
      const fallback = lang === 'zh' ? value.en : value.zh
      return primary ?? fallback ?? ''
    }

    /**
     * 违规消息本地化：中间件的 `message` 是中文诊断句，
     * 英文界面下按 `constraint` 代码给一句英文说明，并保留原文作为细节。
     */
    /** 约束代码的内置英文说明：服务端目录缺失时的兜底，避免英文界面露中文。 */
    const CONSTRAINT_EN = {
      C1: 'Reference integrity: evidence may not point at a node the graph does not have.',
      C2: 'Kind match: a node only accepts the evidence kinds it declares.',
      C3: 'Admission before advance: evidence on a downstream node whose upstream is unsatisfied is out of order.',
      C4: 'Traceability: nodes that require anchors need anchors[].path.',
      C5: 'Completion needs support: a completion claim is refused while a mandatory node is still open.',
      C6: 'Evidence completeness: kind and node may not be empty.',
    }

    function violationText(item, lang, constraints) {
      if (item === null || item === undefined) return ''
      if (lang === 'zh') return item.message ?? ''
      const code = item.constraint ?? item.code ?? ''
      // 英文界面**不回退到中文原文**：优先用约束目录的英文说明，
      // 目录里没有就只报代码——宁可信息少，也不要露中文。
      const known = (constraints ?? []).find((entry) => entry.code === code)
      if (known !== undefined) return known.textEn ?? known.text ?? code
      const builtin = CONSTRAINT_EN[code]
      if (builtin !== undefined) return builtin
      return code
    }

    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        if (document.querySelector('style[data-plugin-css="dsh-neural-workflow/panel.css"]') !== null) return undefined
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-neural-workflow'
        style.dataset.pluginCss = 'dsh-neural-workflow/panel.css'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, [])
    }

    function shortTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /**
     * 卡片几何。
     *
     * 高度**不能写死**：证据种类（`evidenceKinds`）的数量决定徽章换几行，
     * 写死 96px 时 `figure` 的 `['figure','visual_check']` 会溢出到卡片外，
     * 视觉上像徽章挂在边框上。所以高度按内容算，与 CSS 的行高保持一致：
     * 上下 padding 16 + kicker 14 + 标题行(1 或 2 行 × 17) + 元信息 16 + 徽章行(1 或 2 行 × 17) + 间隙 9。
     */
    const CARD_PAD = 16
    const CARD_KICKER = 14
    const CARD_TITLE_LINE = 17
    const CARD_META = 16
    const CARD_KIND_LINE = 17
    const CARD_GAPS = 9
    const CARD_WIDE_W = 208
    const CARD_WIDE_OPEN_EXTRA = 104
    const CARD_NARROW_OPEN_EXTRA = 96

    /**
     * 估一张卡片需要的高度。`chinesePerLine` 是标题一行能放的字数——
     * 中文按全角算，英文按半角算，所以同一句在中英下换行位置不同。
     */
    function cardHeight(node, nodeWidth, open, lang) {
      const name = pickLocalized(node.name, lang) || node.id
      // 中文每字约 12.5px（12.5px 字号），英文每字约 7px；按最坏情况算行数。
      const perChar = lang === 'zh' ? 12.6 : 7.2
      const perLine = Math.max(4, Math.floor((nodeWidth - 20) / perChar))
      const titleLines = Math.min(2, Math.max(1, Math.ceil(name.length / perLine)))
      const kinds = Array.isArray(node.evidenceKinds) ? node.evidenceKinds.length : 0
      // 徽章每个约 34~56px 宽，按 62px 含间距保守估。
      const kindsPerLine = Math.max(1, Math.floor((nodeWidth - 20) / 62))
      const kindLines = kinds === 0 ? 0 : Math.min(2, Math.ceil(kinds / kindsPerLine))
      const base = CARD_PAD + CARD_KICKER + titleLines * CARD_TITLE_LINE + CARD_META + kindLines * CARD_KIND_LINE + CARD_GAPS
      if (!open) return base
      return base + (nodeWidth >= 180 ? CARD_WIDE_OPEN_EXTRA : CARD_NARROW_OPEN_EXTRA)
    }

    /**
     * 图的布局：宽容器一层一列（横排），窄容器一层一行（竖排）。
     *
     * 为什么必须有窄版：右侧栏/窄窗口只有 300 多像素，横排布局塞不进去，
     * 绝对定位的卡片就被压成几十像素宽——中文于是逐字换行，
     * 看上去像"竖排单字"。竖排布局在同样宽度下每条卡片都拿满可用宽度。
     *
     * `availableWidth` 为 null/undefined（首帧、无 ResizeObserver 的离线渲染）
     * 时按横排处理，保持原有行为不变。`openIds` 是展开中的节点 id 集合。
     */
    const NARROW_MAX = 620

    function layout(graph, availableWidth, openIds, lang) {
      const layers = Array.isArray(graph?.layers) ? graph.layers : []
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
      const open = openIds instanceof Set ? openIds : new Set()
      const byLayer = new Map()
      for (const layer of layers) byLayer.set(layer.id, [])
      for (const node of nodes) {
        const key = node.layer ?? 'L0'
        if (!byLayer.has(key)) byLayer.set(key, [])
        byLayer.get(key).push(node)
      }
      for (const list of byLayer.values()) {
        list.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || String(left.id).localeCompare(String(right.id)))
      }
      const heightOf = (node, width) => cardHeight(node, width, open.has(node.id), lang)

      const narrow = typeof availableWidth === 'number' && availableWidth > 0 && availableWidth < NARROW_MAX
      if (narrow) {
        const PAD = 10
        const GAP = 10
        const LAYER_GAP = 14
        const LAYER_HEAD = 18
        const width = Math.max(160, Math.round(availableWidth))
        const nodeWidth = Math.max(120, width - PAD * 2)
        const positions = new Map()
        const heights = new Map()
        const layerLabels = []
        let y = PAD
        let first = true
        for (const [layerId, list] of byLayer) {
          if (list.length === 0) continue
          if (!first) y += LAYER_GAP
          first = false
          // 竖排丢掉列位置，层的分组就只剩顺序；补一行层标题，
          // 否则「问题与设计 / 执行 / 证据与结论 / 表达与交付」在视觉上消失。
          layerLabels.push({ id: layerId, y })
          y += LAYER_HEAD
          for (const node of list) {
            const height = heightOf(node, nodeWidth)
            positions.set(node.id, { x: PAD, y })
            heights.set(node.id, height)
            y += height + GAP
          }
        }
        return {
          positions,
          heights,
          width,
          height: Math.max(120, y - GAP + PAD),
          nodeWidth,
          nodeHeight: 88,
          orientation: 'narrow',
          layerLabels,
        }
      }

      /**
       * 宽版：层为列、同层竖排。列宽必须**按可用宽度算**，不能写死：
       * 4 列 × 208 + 边距会超过整页面板的主列宽，最右两列会被裁掉。
       * 可用宽度足够时用原尺寸；不够时等比例压缩，下限 132（再窄该走竖排）。
       */
      const layerCount = Math.max(1, [...byLayer.values()].filter((list) => list.length > 0).length)
      const budget = typeof availableWidth === 'number' && availableWidth > 0 ? availableWidth : null
      let COL = CARD_WIDE_W + 44
      let NODE_W = CARD_WIDE_W
      if (budget !== null) {
        const PAD = 14
        const room = budget - PAD * 2
        const natural = NODE_W + (layerCount - 1) * COL
        if (natural > room) {
          const scale = room / natural
          NODE_W = Math.max(132, Math.min(CARD_WIDE_W, Math.floor(CARD_WIDE_W * scale)))
          COL = Math.max(NODE_W + 24, Math.floor(COL * scale))
        }
      }
      const positions = new Map()
      const heights = new Map()
      let index = 0
      let maxBottom = 0
      for (const list of byLayer.values()) {
        if (list.length === 0) continue
        let y = 16
        for (const node of list) {
          const height = heightOf(node, NODE_W)
          positions.set(node.id, { x: 14 + index * COL, y })
          heights.set(node.id, height)
          y += height + 18
        }
        maxBottom = Math.max(maxBottom, y - 18)
        index += 1
      }
      const naturalWidth = 14 + Math.max(0, index - 1) * COL + NODE_W + 14
      return {
        positions,
        heights,
        width: budget !== null ? Math.max(Math.min(naturalWidth, budget), 240) : Math.max(320, naturalWidth),
        height: Math.max(140, maxBottom + 16),
        nodeWidth: NODE_W,
        nodeHeight: 96,
        orientation: 'wide',
        layerLabels: [],
      }
    }

    /**
     * 侧栏图标：**不画背景色块**，只画描边。
     *
     * dsh-context / 其它一等面板的图标都是"透明底 + currentColor"——
     * 宿主把图标放进浅色或深色侧栏时，颜色由宿主决定。带死背景色的图标在
     * 深色侧栏里会变成一块和背景同色的方块，看起来就是"根本没加载"。
     */
    function icon(size) {
      return h(
        'svg',
        {
          className: 'nw-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        // 三层收缩的节点网络：一眼能认出是"工作流/网络"，且在小尺寸下不糊。
        h('path', { d: 'M5 5.5h5l2 3' }),
        h('path', { d: 'M19 5.5h-5l-2 3' }),
        h('path', { d: 'M12 8.5v5' }),
        h('path', { d: 'M12 13.5 8 18M12 13.5l4 4.5' }),
        h('circle', { cx: 4, cy: 5.5, r: 1.6 }),
        h('circle', { cx: 20, cy: 5.5, r: 1.6 }),
        h('circle', { cx: 7, cy: 19.5, r: 1.6 }),
        h('circle', { cx: 17, cy: 19.5, r: 1.6 }),
      )
    }

    /**
     * 运行卡：本项目里**每一次阶段派发**的登记（哪个阶段、什么状态、何时开始）。
     *
     * 这是相对任务管理插件的增量：那边只知道"有个子代理在跑"，
     * 这边每次派发都钉在阶段上，于是"训练跑过 3 次、上次失败"和阶段图是同一屏。
     * 只读——派发仍然只能走 `neural_flow` 的 `run`。
     */
    function Runs(props) {
      const { runs, error, t, lang } = props
      const list = Array.isArray(runs) ? runs : []
      const statusOf = (run) => (run?.status === 'ok' ? 'satisfied' : run?.status === 'failed' ? 'blocked' : 'ready')
      const labelOf = (run) => (run?.status === 'ok' ? t('runOk') : run?.status === 'failed' ? t('runFailed') : t('runRunning'))
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nw-card-h' },
          h('h3', { className: 'nw-card-t' }, t('runs')),
          h('span', { className: 'nw-count' }, list.length),
        ),
        typeof error === 'string' && error !== ''
          ? h('div', { className: 'nw-empty' }, `${t('runsUnavailable')}: ${error}`)
          : list.length === 0
            ? h('div', { className: 'nw-empty' }, t('runsNone'))
            : h(
                'ul',
                { className: 'nw-runs' },
                list.map((run) =>
                  h(
                    'li',
                    { className: 'nw-run', key: run.id, 'data-state': statusOf(run) },
                    h('i', { className: 'nw-dot', 'data-state': statusOf(run) }),
                    h('span', { className: 'nw-run-node' }, run.node ?? '?'),
                    h('span', { className: 'nw-badge', 'data-state': statusOf(run) }, labelOf(run)),
                    h('span', { className: 'nw-run-time' }, shortTime(run.finishedAt ?? run.startedAt)),
                  ),
                ),
              ),
      )
    }

    /**
     * 状态徽章的文案与色调。三种状态各一档，不做第四种——
     * 判定只有 satisfied / ready / blocked，多出来的都是编的。
     */
    const STATE_LABEL = {
      satisfied: 'satisfied',
      ready: 'ready',
      blocked: 'blocked',
    }

    /**
     * 单个阶段卡片。
     *
     * 形态学任务管理插件的任务卡：**头部一行上下文 + 右侧状态徽章**、
     * 加粗标题、带图标的元信息行、底部可展开的详情。而不是"一个圆点加一个名字"
     * 的散点图——那种图能看出形状，看不出"这个阶段还差什么"。
     */
    /**
     * 列表视图：按层分组的阶段列表。
     *
     * 为什么还要一个列表：图能看出**形状**（谁在谁下游），但窄栏里
     * 图再自适应也只剩一列、还占掉整屏高度。列表是任务管理那种"一行一个任务、
     * 状态在右、点开看详情"的读法，扫读效率高得多。两个视图读的是同一份判定，
     * 不是两套数据。
     */
    function StageList(props) {
      const { layers, nodes, states, layerNames, openIds, onToggle, t, lang } = props
      const byLayer = new Map()
      for (const layer of layers) byLayer.set(layer.id, [])
      for (const node of nodes) {
        const key = node.layer ?? 'L0'
        if (!byLayer.has(key)) byLayer.set(key, [])
        byLayer.get(key).push(node)
      }
      for (const list of byLayer.values()) {
        list.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || String(left.id).localeCompare(String(right.id)))
      }

      return h(
        'div',
        { className: 'nw-list' },
        [...byLayer.entries()].map(([layerId, list]) =>
          list.length === 0
            ? null
            : h(
                'div',
                { className: 'nw-list-group', key: layerId },
                h(
                  'div',
                  { className: 'nw-list-head' },
                  h('span', { className: 'nw-list-layer' }, layerId),
                  h('span', { className: 'nw-list-name' }, layerNames.get(layerId) ?? layerId),
                  h('span', { className: 'nw-count' }, list.length),
                ),
                list.map((node) => {
                  const state = states[node.id] ?? {}
                  const status = state.state ?? 'blocked'
                  const open = openIds.has(node.id)
                  const count = typeof state.evidence === 'number' ? state.evidence : 0
                  const failures = typeof state.failures === 'number' ? state.failures : 0
                  const kinds = Array.isArray(node.evidenceKinds) ? node.evidenceKinds : []
                  const got = Array.isArray(state.kinds) ? state.kinds : []
                  const gate = pickLocalized(node.gate, lang)
                  const hint = pickLocalized(node.hint, lang)
                  const commands = Array.isArray(node.gateCommands) ? node.gateCommands : []
                  return h(
                    'div',
                    { className: 'nw-list-row', key: node.id, 'data-state': status, 'data-node': node.id },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'nw-list-hit',
                        onClick: () => onToggle(node.id),
                        'aria-expanded': open ? 'true' : 'false',
                        title: hint,
                      },
                      h('i', { className: 'nw-dot', 'data-state': status }),
                      h(
                        'span',
                        { className: 'nw-list-main' },
                        h('span', { className: 'nw-list-title' }, pickLocalized(node.name, lang) || node.id),
                        h(
                          'span',
                          { className: 'nw-list-meta' },
                          `${node.id} · ${count} ${t('evidence')}`,
                          failures > 0 ? h('span', { className: 'nw-badge nw-badge-warn' }, `⚠ ${failures}`) : null,
                          node.requiresAllKinds === true ? h('span', { className: 'nw-badge' }, t('dualGate')) : null,
                          node.requiresAnchor === true ? h('span', { className: 'nw-badge' }, t('anchor')) : null,
                        ),
                      ),
                      h('span', { className: 'nw-badge', 'data-state': status }, t(STATE_LABEL[status] ?? 'blocked')),
                    ),
                    open
                      ? h(
                          'div',
                          { className: 'nw-list-body' },
                          hint !== '' ? h('div', { className: 'nw-node-hint' }, hint) : null,
                          h(
                            'div',
                            { className: 'nw-node-kinds' },
                            kinds.map((kind) =>
                              h('span', { className: 'nw-kind', key: kind, 'data-got': got.includes(kind) ? 'true' : 'false' }, kind),
                            ),
                          ),
                          gate !== '' ? h('div', { className: 'nw-node-gate' }, h('b', null, t('gate')), gate) : null,
                          commands.length > 0
                            ? h(
                                'div',
                                { className: 'nw-node-cmds' },
                                h('b', null, t('gateCommands')),
                                commands.map((command) => h('code', { key: command }, command)),
                              )
                            : null,
                        )
                      : null,
                  )
                }),
              ),
        ),
      )
    }

    function StageCard(props) {
      const { node, state, geometry, position, open, onToggle, t, lang } = props
      const name = pickLocalized(node.name, lang) || node.id
      const hint = pickLocalized(node.hint, lang)
      const gate = pickLocalized(node.gate, lang)
      const status = state.state ?? 'blocked'
      const count = typeof state.evidence === 'number' ? state.evidence : 0
      const failures = typeof state.failures === 'number' ? state.failures : 0
      const kinds = Array.isArray(node.evidenceKinds) ? node.evidenceKinds : []
      const got = Array.isArray(state.kinds) ? state.kinds : []
      const commands = Array.isArray(node.gateCommands) ? node.gateCommands : []
      const height = geometry.heights.get(node.id) ?? geometry.nodeHeight

      return h(
        'div',
        {
          key: node.id,
          className: 'nw-node',
          'data-state': status,
          'data-open': open ? 'true' : 'false',
          'data-node': node.id,
          style: { left: `${position.x}px`, top: `${position.y}px`, width: `${geometry.nodeWidth}px`, height: `${height}px` },
        },
        h(
          'button',
          {
            type: 'button',
            className: 'nw-node-hit',
            onClick: () => onToggle(node.id),
            'aria-expanded': open ? 'true' : 'false',
            title: hint,
          },
          h(
            'div',
            { className: 'nw-node-head' },
            h('span', { className: 'nw-node-kicker' }, node.id),
            h('span', { className: 'nw-badge', 'data-state': status }, t(STATE_LABEL[status] ?? 'blocked')),
          ),
          h('div', { className: 'nw-node-name' }, name),
          h(
            'div',
            { className: 'nw-node-meta' },
            h('span', null, `${count} ${t('evidence')}`),
            failures > 0 ? h('span', { className: 'nw-badge nw-badge-warn' }, `⚠ ${failures}`) : null,
            node.requiresAllKinds === true ? h('span', { className: 'nw-badge' }, t('dualGate')) : null,
          ),
          h(
            'div',
            { className: 'nw-node-kinds' },
            kinds.map((kind) =>
              h(
                'span',
                { className: 'nw-kind', key: kind, 'data-got': got.includes(kind) ? 'true' : 'false' },
                kind,
              ),
            ),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'nw-node-body' },
              hint !== '' ? h('div', { className: 'nw-node-hint' }, hint) : null,
              gate !== '' ? h('div', { className: 'nw-node-gate' }, h('b', null, t('gate')), gate) : null,
              commands.length > 0
                ? h(
                    'div',
                    { className: 'nw-node-cmds' },
                    h('b', null, t('gateCommands')),
                    commands.map((command) => h('code', { key: command }, command)),
                  )
                : null,
              h(
                'div',
                { className: 'nw-node-foot' },
                h('span', { className: 'nw-node-anchor' }, node.requiresAnchor === true ? t('needsAnchor') : t('noAnchor')),
                h('button', { type: 'button', className: 'nw-link', onClick: () => onToggle(node.id) }, t('collapse')),
              ),
            )
          : null,
      )
    }

    /**
     * 工作流图布。
     *
     * 两件事同时成立才算对：**形状**（层的顺序、边的方向）和**信息**
     * （每个阶段还差什么、能不能推进）。所以卡片是富卡片、可展开，
     * 而不是一个圆点；缩放只作用于整体尺寸，不改布局语义。
     */
    function Board(props) {
      const { graph, verdict, t, lang } = props
      const scrollRef = useRef(null)
      const [availWidth, setAvailWidth] = useState(null)
      const [openIds, setOpenIds] = useState(() => new Set())
      // 窄容器默认列表：图再自适应也只剩一列，列表扫读更快。宽容器默认图。
      const [view, setView] = useState(null)

      /**
       * 量**容器**宽度，而不是信 window.innerWidth：右侧栏里窗口很宽、面板很窄，
       * 用窗口宽度选布局就会选错。ResizeObserver 缺失时退化为不量（按横排），
       * 离线渲染/旧浏览器都不会因此抛错。
       */
      useEffect(() => {
        const element = scrollRef.current
        if (element === null || element === undefined) return undefined
        if (typeof ResizeObserver !== 'function') return undefined
        const measure = () => {
          const next = Math.round(element.clientWidth ?? 0)
          if (next > 0) setAvailWidth(next)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      const width = typeof props.width === 'number' ? props.width : availWidth
      const geometry = useMemo(() => layout(graph, width, openIds, lang), [graph, width, openIds, lang])
      // 用户没选过视图时按容器宽度自动选：窄栏给列表，宽栏给图。
      // 一旦用户点了切换，就尊重用户的选择（`view !== null`）。
      const effectiveView = view ?? (geometry.orientation === 'narrow' ? 'list' : 'graph')
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
      const states = verdict?.nodes ?? {}
      const labels = Array.isArray(graph?.layers) ? graph.layers : []
      const layerNames = new Map(labels.map((layer) => [layer.id, pickLocalized(layer.name, lang) || layer.id]))
      const vertical = geometry.orientation === 'narrow'
      const allOpen = nodes.length > 0 && nodes.every((node) => openIds.has(node.id))

      const toggle = (id) => {
        setOpenIds((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleAll = () => {
        setOpenIds(allOpen ? new Set() : new Set(nodes.map((node) => node.id)))
      }

      const edges = (Array.isArray(graph?.edges) ? graph.edges : []).map((edge) => {
        const from = geometry.positions.get(edge.from)
        const to = geometry.positions.get(edge.to)
        if (from === undefined || to === undefined) return null
        const fromHeight = geometry.heights.get(edge.from) ?? geometry.nodeHeight
        const toHeight = geometry.heights.get(edge.to) ?? geometry.nodeHeight
        const live = states[edge.from]?.state === 'satisfied'
        const stroke = live ? 'var(--dsw-alias-state-success-primary,#1a9c5b)' : 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))'
        const common = {
          key: `${edge.from}->${edge.to}`,
          stroke,
          strokeWidth: live ? 2 : 1.4,
          opacity: live ? 0.9 : 0.55,
          fill: 'none',
          strokeDasharray: live ? undefined : '4 5',
        }
        if (vertical || from.x === to.x) {
          // 同列/竖排：从**下边**出、到**上边**进。走左右边会绕出反 S 形，
          // 压在两张卡之间的空白上；窄列下这条 S 会明显穿过卡片本体。
          const x = from.x + geometry.nodeWidth / 2
          const y1 = from.y + fromHeight
          const y2 = to.y
          return h('path', { ...common, d: `M${x} ${y1} L${x} ${y2}` })
        }
        const x1 = from.x + geometry.nodeWidth
        const y1 = from.y + fromHeight / 2
        const x2 = to.x
        const y2 = to.y + toHeight / 2
        const mid = (x1 + x2) / 2
        return h('path', { ...common, d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` })
      })

      const cards = nodes.map((node) => {
        const position = geometry.positions.get(node.id)
        if (position === undefined) return null
        return h(StageCard, {
          key: node.id,
          node,
          state: states[node.id] ?? {},
          geometry,
          position,
          open: openIds.has(node.id),
          onToggle: toggle,
          t,
          lang,
        })
      })

      return h(
        'div',
        { className: 'nw-canvas-wrap', 'data-view': effectiveView },
        h(
          'div',
          { className: 'nw-canvas-tools' },
          h('span', { className: 'nw-canvas-note' }, `${nodes.length} ${t('stages')}`),
          h(
            'button',
            {
              type: 'button',
              className: 'nw-link',
              onClick: () => setView(effectiveView === 'graph' ? 'list' : 'graph'),
              'data-view-toggle': effectiveView,
            },
            effectiveView === 'graph' ? t('viewList') : t('viewGraph'),
          ),
          h('button', { type: 'button', className: 'nw-link', onClick: toggleAll }, allOpen ? t('collapseAll') : t('expandAll')),
        ),
        effectiveView === 'list'
          ? h(StageList, { layers: labels, nodes, states, layerNames, openIds, onToggle: toggle, t, lang })
          : h(
              'div',
              { className: 'nw-canvas-scroll', ref: scrollRef, 'data-orientation': geometry.orientation },
              h(
                'div',
                { className: 'nw-canvas', style: { width: `${geometry.width}px`, height: `${geometry.height}px` } },
                h('svg', { className: 'nw-edges', width: geometry.width, height: geometry.height }, edges),
                (geometry.layerLabels ?? []).map((label) =>
                  h(
                    'div',
                    { className: 'nw-canvas-layer', key: `layer-${label.id}`, style: { left: '10px', top: `${label.y}px` } },
                    `${label.id} ${layerNames.get(label.id) ?? ''}`.trim(),
                  ),
                ),
                cards,
                h('div', { style: { display: 'none' } }, labels.map((layer) => layer.id).join(',')),
              ),
            ),
      )
    }

    function LayerBars(props) {
      const { graph, verdict, t, lang } = props
      const layers = Array.isArray(verdict?.layers) && verdict.layers.length > 0
        ? verdict.layers
        : (Array.isArray(graph?.layers) ? graph.layers : []).map((layer) => ({ id: layer.id, satisfied: 0, total: 0 }))
      const names = new Map((Array.isArray(graph?.layers) ? graph.layers : []).map((layer) => [layer.id, pickLocalized(layer.name, lang) || layer.id]))
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nw-card-h' },
          h('h3', { className: 'nw-card-t' }, t('layers')),
        ),
        layers.map((layer) =>
          h(
            'div',
            { className: 'nw-layer', key: layer.id },
            h(
              'div',
              { className: 'nw-layer-k' },
              h('span', { className: 'nw-bar-n' }, `${layer.id} ${names.get(layer.id) ?? ''}`.trim()),
              h('span', { className: 'nw-bar' }, h('i', { style: { width: `${layer.total === 0 ? 0 : Math.round((layer.satisfied / layer.total) * 100)}%` } })),
              h('span', { className: 'nw-bar-n' }, `${layer.satisfied}/${layer.total}`),
            ),
          ),
        ),
      )
    }

    function Violations(props) {
      const { verdict, t, lang, constraints } = props
      const violations = Array.isArray(verdict?.violations) ? verdict.violations : []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nw-card-h' },
          h('h3', { className: 'nw-card-t' }, t('violations')),
          h('span', { className: 'nw-count' }, violations.length),
        ),
        violations.length === 0
          ? h('div', { className: 'nw-ok' }, t('noViolations'))
          : h(
              'ul',
              { className: 'nw-vios' },
              violations.map((item, index) =>
                h(
                  'li',
                  { className: 'nw-vio', key: `${item.code}-${index}` },
                  h('span', { className: 'nw-vio-code' }, item.constraint ?? item.code ?? '—'),
                  h('span', { className: 'nw-vio-t' }, violationText(item, lang, constraints)),
                ),
              ),
            ),
      )
    }

    function Ledger(props) {
      const { ledger, t } = props
      const items = Array.isArray(ledger) ? [...ledger].reverse() : []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nw-card-h' },
          h('h3', { className: 'nw-card-t' }, t('ledger')),
          h('span', { className: 'nw-count' }, items.length),
        ),
        items.length === 0
          ? h('div', { className: 'nw-empty' }, t('emptyLedger'))
          : h(
              'ul',
              { className: 'nw-ledger' },
              items.slice(0, 60).map((item) =>
                h(
                  'li',
                  { className: 'nw-ev', key: item.id },
                  h(
                    'div',
                    { className: 'nw-ev-top' },
                    h('span', { className: 'nw-ev-kind' }, item.kind ?? '?'),
                    h('span', { className: 'nw-ev-node' }, item.node ?? '?'),
                    h('span', { className: 'nw-ev-time' }, shortTime(item.at)),
                  ),
                  typeof item.note === 'string' && item.note !== '' ? h('div', { className: 'nw-ev-note' }, item.note) : null,
                  Array.isArray(item.anchors) && item.anchors.length > 0
                    ? h(
                        'div',
                        { className: 'nw-ev-anchors' },
                        `${t('anchors')}: ${item.anchors.map((anchor) => anchor.path).join(' · ')}`,
                      )
                    : null,
                ),
              ),
            ),
      )
    }

    /**
     * 知识库卡片：检索本项目 skill 沉淀的 611 条经验（错误/方法/idea 配方）。
     *
     * 交互刻意只有两步：先搜（query），点开某条才取全文（entry）。
     * 这与工具的 `action=knowledge` 走**同一个检索函数**（宿主侧 lib/kb.js），
     * 所以面板里看到的和模型查到的是同一批条目——不存在"两套知识"。
     */
    function Knowledge(props) {
      const { t } = props
      const [query, setQuery] = useState('')
      const [result, setResult] = useState({ matches: [], stats: null, pending: false, error: undefined })
      const [openEntry, setOpenEntry] = useState(null)
      const tokenRef = useRef(0)

      const run = () => {
        const value = query.trim()
        if (value === '') {
          setResult({ matches: [], stats: result.stats, pending: false, error: undefined })
          return
        }
        const token = ++tokenRef.current
        setResult((prev) => ({ ...prev, pending: true, error: undefined }))
        fetch(`${API}/knowledge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: value, limit: 8 }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (token !== tokenRef.current) return
            if (payload?.ok !== true) {
              setResult({ matches: [], stats: payload?.stats ?? null, pending: false, error: payload?.error?.message ?? t('searchFailed') })
              return
            }
            setResult({ matches: Array.isArray(payload.matches) ? payload.matches : [], stats: payload.stats ?? null, pending: false, error: undefined })
          })
          .catch(() => {
            if (token !== tokenRef.current) return
            setResult({ matches: [], stats: null, pending: false, error: t('requestFailed') })
          })
      }

      const open = (id) => {
        setOpenEntry({ pending: true, id })
        fetch(`${API}/knowledge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entry: id }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            setOpenEntry(payload?.ok === true ? { ...payload.entry, pending: false } : { id, pending: false, error: payload?.error?.message ?? t('entryFailed') })
          })
          .catch(() => setOpenEntry({ id, pending: false, error: t('requestFailed') }))
      }

      // 首次挂载先拿一次统计（不需要 query，只要总数与分布）。
      useEffect(() => {
        fetch(`${API}/knowledge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (payload?.ok === true) setResult((prev) => ({ ...prev, stats: payload.stats ?? null }))
          })
          .catch(() => {})
      }, [])

      const stats = result.stats
      const matches = result.matches

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'nw-card-h' },
          h('h3', { className: 'nw-card-t' }, t('knowledge')),
          stats === null ? null : h('span', { className: 'nw-count' }, String(stats.total)),
        ),
        h(
          'div',
          { className: 'nw-search' },
          h('input', {
            className: 'nw-input',
            type: 'text',
            value: query,
            placeholder: t('knowledgePlaceholder'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') run()
            },
          }),
          h('button', { className: 'nw-btn', onClick: run, disabled: result.pending === true }, result.pending === true ? '…' : t('search')),
        ),
        result.error === undefined ? null : h('div', { className: 'nw-empty' }, result.error),
        matches.length === 0
          ? h('div', { className: 'nw-empty' }, query.trim() === '' ? t('knowledgeHint') : t('knowledgeNone'))
          : h(
              'ul',
              { className: 'nw-kbs' },
              matches.map((item) =>
                h(
                  'li',
                  { className: 'nw-kb', key: item.id },
                  h(
                    'button',
                    { className: 'nw-kb-btn', onClick: () => open(item.id) },
                    h('span', { className: 'nw-kb-id' }, item.id),
                    h('span', { className: 'nw-kb-t' }, item.title),
                    item.severity === 'critical' ? h('span', { className: 'nw-kb-crit' }, 'critical') : null,
                  ),
                  typeof item.gist === 'string' && item.gist !== '' ? h('div', { className: 'nw-kb-gist' }, item.gist) : null,
                ),
              ),
            ),
        openEntry === null
          ? null
          : h(
              'div',
              { className: 'nw-kb-detail' },
              openEntry.pending === true
                ? h('div', { className: 'nw-empty' }, '…')
                : openEntry.error !== undefined
                  ? h('div', { className: 'nw-empty' }, openEntry.error)
                  : h(
                      'div',
                      null,
                      h('div', { className: 'nw-kb-detail-head' }, `${openEntry.id} · ${openEntry.title ?? ''}`),
                      openEntry.rootCause ? h('div', { className: 'nw-kb-row' }, h('b', null, t('why')), openEntry.rootCause) : null,
                      openEntry.approach ? h('div', { className: 'nw-kb-row' }, h('b', null, t('fix')), openEntry.approach) : null,
                      openEntry.command ? h('div', { className: 'nw-kb-row' }, h('b', null, t('command')), h('code', null, openEntry.command)) : null,
                      Array.isArray(openEntry.forbid) && openEntry.forbid.length > 0
                        ? h(
                            'div',
                            { className: 'nw-kb-row' },
                            h('b', null, t('forbid')),
                            h('ul', { className: 'nw-kb-forbid' }, openEntry.forbid.map((item, index) => h('li', { key: index }, item))),
                          )
                        : null,
                      h('button', { className: 'nw-btn', onClick: () => setOpenEntry(null) }, t('close')),
                    ),
            ),
      )
    }

    /**
     * 面板主体：图 + 判定 + 账本。
     * `sessionId` 为 undefined 时（全局面板、尚未选中会话）只读图，不发判定请求。
     */
    function Panel(props) {
      const { t, sessionId, compact, lang } = props
      const activeLanguage = lang ?? 'en'
      useStyles()
      const [bundle, setBundle] = useState({ graph: null, constraints: [], degraded: false, binary: null })
      const [state, setState] = useState({ ledger: [], runs: [], verdict: null, brief: null, degraded: false, reason: undefined })
      const [busy, setBusy] = useState(false)
      const [selftest, setSelftest] = useState(null)
      const seqRef = useRef(0)

      const loadGraph = () => {
        fetch(`${API}/graph`, { method: 'GET' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (payload?.ok) setBundle({ graph: payload.graph, constraints: payload.constraints ?? [], degraded: payload.degraded === true, binary: payload.binary ?? null })
          })
          .catch(() => {})
      }

      const loadState = () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const token = ++seqRef.current
        fetch(`${API}/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (token !== seqRef.current || payload === null) return
            if (payload.ok !== true) {
              setState({ ledger: [], runs: [], verdict: null, brief: null, degraded: false, reason: payload?.error?.message })
              return
            }
            setState({
              ledger: Array.isArray(payload.ledger) ? payload.ledger : [],
              runs: Array.isArray(payload.runs) ? payload.runs : [],
              runsError: payload.runsError,
              verdict: payload.verdict ?? null,
              brief: payload.brief ?? null,
              degraded: payload.degraded === true,
              reason: payload.reason,
            })
          })
          .catch(() => {})
      }

      useEffect(() => {
        loadGraph()
      }, [])
      useEffect(() => {
        loadState()
      }, [sessionId])

      const refresh = () => {
        setBusy(true)
        loadGraph()
        loadState()
        setTimeout(() => setBusy(false), 320)
      }

      const runSelftest = () => {
        fetch(`${API}/selftest`, { method: 'GET' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => setSelftest(payload ?? { ok: false }))
          .catch(() => setSelftest({ ok: false }))
      }

      const graphNodeCount = Array.isArray(bundle.graph?.nodes) ? bundle.graph.nodes.length : 0
      const progress = state.brief?.progress ?? state.verdict?.progress ?? { satisfied: 0, total: graphNodeCount }
      const counts = state.brief?.counts ?? { satisfied: 0, ready: 0, blocked: 0 }
      const frontier = state.brief?.frontier ?? state.verdict?.frontier ?? []
      const degraded = bundle.degraded === true || state.degraded === true

      return h(
        'div',
        { className: 'nw-panel', 'data-compact': compact === true ? 'true' : undefined },
        h(
          'div',
          { className: 'nw-scroll' },
          h(
            'div',
            { className: 'nw-inner' },
            h(
              'div',
              { className: 'nw-head' },
              h('h2', { className: 'nw-h1' }, t('title')),
              h(
                'div',
                { className: 'nw-headctl' },
                h('button', { className: 'nw-btn', onClick: runSelftest }, t('selftest')),
                h('button', { className: 'nw-btn', onClick: refresh, disabled: busy }, t('refresh')),
              ),
            ),
            h('div', { className: 'nw-sub' }, t('panelHint')),
            degraded
              ? h(
                  'div',
                  { className: 'nw-warn' },
                  h('b', null, t('degraded')),
                  h('div', null, state.reason ?? t('degradedHint')),
                )
              : null,
            selftest !== null
              ? h(
                  'div',
                  { className: 'nw-warn', style: { borderColor: 'var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } },
                  selftest.ok === true
                    ? `${t('selftestOk')} (${selftest.value?.checks ?? 0} checks)`
                    : `${t('selftestFail')}: ${selftest.error?.message ?? 'unknown'}`,
                )
              : null,
            h(
              'div',
              { className: 'nw-kpis' },
              h(
                'div',
                { className: 'nw-kpi' },
                h('div', { className: 'nw-kpi-k' }, t('progress')),
                h('div', { className: 'nw-kpi-v' }, `${progress.satisfied}/${progress.total}`),
                h('div', { className: 'nw-kpi-s' }, `${counts.satisfied} ${t('satisfied')}`),
              ),
              h(
                'div',
                { className: 'nw-kpi' },
                h('div', { className: 'nw-kpi-k' }, t('ready')),
                h('div', { className: 'nw-kpi-v' }, String(counts.ready)),
                h('div', { className: 'nw-kpi-s' }, counts.ready === 0 ? '—' : t('frontier')),
              ),
              h(
                'div',
                { className: 'nw-kpi' },
                h('div', { className: 'nw-kpi-k' }, t('blocked')),
                h('div', { className: 'nw-kpi-v' }, String(counts.blocked)),
                h('div', { className: 'nw-kpi-s' }, ''),
              ),
              h(
                'div',
                { className: 'nw-kpi' },
                h('div', { className: 'nw-kpi-k' }, t('violations')),
                h('div', { className: 'nw-kpi-v' }, String(state.brief?.violations?.length ?? 0)),
                h('div', { className: 'nw-kpi-s' }, frontier.length === 0 ? '—' : frontier.slice(0, 2).join(', ')),
              ),
            ),
            h(
              'div',
              { className: 'nw-grid' },
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'nw-card' },
                  h(
                    'div',
                    { className: 'nw-card-h' },
                    h('h3', { className: 'nw-card-t' }, t('panel')),
                    h('span', { className: 'nw-legend' }, null),
                  ),
                  h(
                    'div',
                    { className: 'nw-legend' },
                    h('span', { className: 'nw-legend-i' }, h('i', { className: 'nw-dot', 'data-state': 'satisfied' }), t('satisfied')),
                    h('span', { className: 'nw-legend-i' }, h('i', { className: 'nw-dot', 'data-state': 'ready' }), t('ready')),
                    h('span', { className: 'nw-legend-i' }, h('i', { className: 'nw-dot', 'data-state': 'blocked' }), t('blocked')),
                  ),
                  bundle.graph === null
                    ? h('div', { className: 'nw-empty' }, '…')
                    : h(Board, { graph: bundle.graph, verdict: state.verdict, t, lang: activeLanguage }),
                ),
                h(
                  'div',
                  { className: 'nw-card' },
                  h(Violations, { verdict: state.verdict, t, lang: activeLanguage, constraints: bundle.constraints }),
                ),
                h(
                  'div',
                  { className: 'nw-card' },
                  h(Ledger, { ledger: state.ledger, t }),
                ),
                h(
                  'div',
                  { className: 'nw-card' },
                  h(Knowledge, { t }),
                ),
              ),
              h(
                'div',
                null,
                bundle.graph === null
                  ? null
                  : h('div', { className: 'nw-card' }, h(LayerBars, { graph: bundle.graph, verdict: state.verdict, t, lang: activeLanguage })),
                h('div', { className: 'nw-card' }, h(Runs, { runs: state.runs, error: state.runsError, t, lang: activeLanguage })),
                h(
                  'div',
                  { className: 'nw-card' },
                  h('div', { className: 'nw-card-h' }, h('h3', { className: 'nw-card-t' }, t('violations'))),
                  h(
                    'ul',
                    { className: 'nw-vios' },
                    (bundle.constraints ?? []).map((item) =>
                      h(
                        'li',
                        { className: 'nw-vio', key: item.code, style: { borderLeftColor: 'var(--dsw-alias-border-l2)' } },
                        h('span', { className: 'nw-vio-code', style: { color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l2)' } }, item.code),
                        h('span', { className: 'nw-vio-t' }, activeLanguage === 'zh' ? item.text : (item.textEn ?? item.text)),
                      ),
                    ),
                  ),
                ),
                bundle.binary !== null && bundle.binary !== undefined
                  ? h(
                      'div',
                      { className: 'nw-card' },
                      h('div', { className: 'nw-card-h' }, h('h3', { className: 'nw-card-t' }, 'native')),
                      h('div', { className: 'nw-empty' }, String(bundle.binary)),
                    )
                  : null,
              ),
            ),
          ),
        ),
      )
    }

    /** 会话视图：同一块面板，绑定当前会话。 */
    function ConversationView(props) {
      const { t, lang } = props
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      return h(Panel, { t, sessionId, compact: true, lang })
    }

    /** 一级面板图标。 */
    function PanelIcon(props) {
      useStyles()
      const size = typeof props.size === 'number' ? props.size : 18
      return icon(size)
    }

    /** 右侧栏标签页的标题：图标 + 短标签，与 dsh-context 的 Context 页签同构。 */
    function PanelTabTitle(props) {
      const { t } = props
      const size = typeof props.size === 'number' ? props.size : 16
      return h('span', { className: 'nw-title' }, icon(size), h('span', { className: 'nw-title-label' }, t('view')))
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-neural-workflow: dictionaries')
      const t = ctx.locale.bind(NS)
      /**
       * 标签必须**永远可读**：`t` 在字典未就绪时可能抛或返回空串，
       * 而侧栏行拿不到 label 就不渲染——那正是"装好了、slot 也注册了，
       * 但侧栏什么都没出现"的成因。所以这里带静态回退。
       */
      const labelOf = (key, fallback) => () => {
        try {
          const value = t(key)
          return typeof value === 'string' && value !== '' ? value : fallback
        } catch {
          return fallback
        }
      }

      ctx.effect(
        () => {
          const disposers = []
          // 一级面板：图标 + 整页（与 dsh-context 同构，order 紧邻它）
          disposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: labelOf('panel', activeLang(ctx) === 'zh' ? '神经工作流' : 'Neural flow'), locale: NS },
                PanelIcon,
              ),
            ),
          )
          disposers.push(
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => h(Panel, { t, sessionId: '', compact: false, lang: activeLang(ctx) })),
            ),
          )
          // 会话视图标签：与「上下文 / 舰队」并列
          disposers.push(
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                { name: 'conversation.view', id: PANEL_ID, order: 25, label: labelOf('view', activeLang(ctx) === 'zh' ? '工作流' : 'Workflow'), locale: NS },
                (props) => h(ConversationView, { ...props, t, lang: activeLang(ctx) }),
              ),
            ),
          )
          return () => {
            for (const dispose of disposers) if (typeof dispose === 'function') dispose()
          }
        },
        'dsh-neural-workflow: placements',
      )

      /**
       * 右侧栏入口：与 dsh-context 走**同一条公开路径**（两步注册）。
       *
       * 1. `ctx.sidebarRightTabs.register({id, kind, title, guide})` 声明 tab 类型；
       * 2. `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个 keyed slot
       *    按同一个 id 提供 body 与标题。
       *
       * 为什么不用 `ctx.effect` 包起来：`ctx.inject(deps, cb)` 本身就是一个 effect，
       * 服务缺席时回调根本不执行、服务到来时自动重放——把它再包一层会重复注册。
       * 老宿主没有 `sidebarRightTabs` 时这里整体跳过，左侧面板照常可用。
       */
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], (scoped) => {
          const registry = scoped.sidebarRightTabs
          if (registry === undefined || registry === null || typeof registry.register !== 'function') return undefined
          const disposers = []
          const keep = (dispose) => {
            if (typeof dispose === 'function') disposers.push(dispose)
          }
          try {
            keep(
              registry.register({
                id: PANEL_ID,
                kind: PANEL_ID,
                title: labelOf('view', activeLang(scoped) === 'zh' ? '工作流' : 'Workflow'),
                guide: [
                  {
                    id: PANEL_ID,
                    order: 30,
                    title: labelOf('panel', activeLang(scoped) === 'zh' ? '神经工作流' : 'Neural flow'),
                    description: labelOf('guideDescription', activeLang(scoped) === 'zh' ? '阶段约束、证据账本与越序拦截，跟在聊天旁边看' : 'Stage constraints, evidence ledger and out-of-order blocking, beside the chat'),
                    icon: (props) => icon(typeof props?.size === 'number' ? props.size : 16),
                  },
                ],
              }),
            )
            keep(
              scoped.slots.inject('sidebar.right.pane.tab', () =>
                scoped.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: NS }, (props) =>
                  h(ConversationView, { ...props, t, lang: activeLang(scoped) }),
                ),
              ),
            )
            keep(
              scoped.slots.inject('sidebar.right.pane.tab.title', () =>
                scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: PANEL_ID }, () => h(PanelTabTitle, { t })),
              ),
            )
          } catch {
            for (const dispose of disposers) if (typeof dispose === 'function') dispose()
            return undefined
          }
          return () => {
            for (const dispose of disposers) if (typeof dispose === 'function') dispose()
          }
        })
      }
    }

    const module_ = { exports: {} }
    module_.exports.name = PANEL_ID
    module_.exports.inject = inject
    module_.exports.apply = apply
    /**
     * 测试探针：`scripts/render-check.mjs` 直接渲染这些组件来断言双语，
     * 因为 Panel 的图走异步 fetch，同步桩里拿不到真实数据——只测 Panel 会假通过。
     * 生产路径不读它，没有副作用。
     */
    module_.exports.__test__ = { Board, StageList, Runs, LayerBars, Violations, pickLocalized, activeLang, violationText, layout, PanelTabTitle, NARROW_MAX }
    return module_.exports
  },
})
