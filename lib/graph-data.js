/** 生成文件：由 scripts/build.mjs 从 graph/neural-paper-workflow.json 生成，勿手改。 */
export const GRAPH_DATA = {
  "id": "neural-paper-workflow",
  "version": 1,
  "source": "skills/neural-paper-workflow/SKILL.md § 阶段编排 / 质量门",
  "layers": [
    {
      "id": "L0",
      "order": 0,
      "name": {
        "zh": "问题与设计",
        "en": "Problem & design"
      }
    },
    {
      "id": "L1",
      "order": 1,
      "name": {
        "zh": "执行",
        "en": "Execution"
      }
    },
    {
      "id": "L2",
      "order": 2,
      "name": {
        "zh": "证据与结论",
        "en": "Evidence & claims"
      }
    },
    {
      "id": "L3",
      "order": 3,
      "name": {
        "zh": "表达与交付",
        "en": "Expression & delivery"
      }
    }
  ],
  "nodes": [
    {
      "id": "scope",
      "layer": "L0",
      "order": 10,
      "name": {
        "zh": "研究范围与创新",
        "en": "Scope & novelty"
      },
      "hint": {
        "zh": "把研究问题转化为可证伪假设，定义任务、数据范围、基线、预期贡献、失败条件与潜在反例。",
        "en": "Turn the question into a falsifiable hypothesis; fix task, data scope, baselines, contribution, failure conditions and counterexamples."
      },
      "evidenceKinds": [
        "hypothesis",
        "baseline",
        "note"
      ],
      "requiresAllKinds": false,
      "requiresAnchor": true,
      "requiredFor": [
        "completion"
      ],
      "gate": {
        "zh": "主张可证伪；基线与评价协议明确；贡献未与已有工作混淆。",
        "en": "Claims falsifiable; baselines and evaluation protocol explicit; contribution not conflated with prior work."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_innovation_brief.py"
      ]
    },
    {
      "id": "develop",
      "layer": "L0",
      "order": 20,
      "name": {
        "zh": "开发",
        "en": "Develop"
      },
      "hint": {
        "zh": "定义模块接口、配置方案、随机性控制、依赖版本、日志字段与最小可运行测试；先复现基线，再引入新模块。",
        "en": "Define module interfaces, configuration, randomness control, dependency pins, log fields and a minimal runnable test; reproduce the baseline before adding modules."
      },
      "evidenceKinds": [
        "code",
        "test",
        "note"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "入口命令、最小测试、配置加载和随机种子可运行；实验代码与论文代码路径一致。",
        "en": "Entry command, minimal test, config loading and seeds run; experiment and paper code share one path."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_minimal_change.py"
      ]
    },
    {
      "id": "train",
      "layer": "L1",
      "order": 10,
      "name": {
        "zh": "训练",
        "en": "Train"
      },
      "hint": {
        "zh": "登记数据版本、划分、预处理、硬件、环境、随机种子、超参数、检查点与资源消耗；保存完整配置与原始日志。",
        "en": "Record data version, splits, preprocessing, hardware, environment, seeds, hyperparameters, checkpoints and cost; keep full configs and raw logs."
      },
      "evidenceKinds": [
        "run",
        "log",
        "note"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "数据划分无泄漏；训练日志完整；异常运行单独标记；比较运行使用兼容预算。",
        "en": "No split leakage; complete logs; anomalous runs flagged separately; comparable runs share a compatible budget."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_leakage.py"
      ]
    },
    {
      "id": "infer",
      "layer": "L1",
      "order": 20,
      "name": {
        "zh": "推理",
        "en": "Inference"
      },
      "hint": {
        "zh": "固定检查点、推理配置、阈值与后处理；把预测样本、错误样本与运行时指标绑定到对应训练运行。",
        "en": "Pin checkpoint, inference config, thresholds and post-processing; bind predictions, error samples and runtime metrics to the training run."
      },
      "evidenceKinds": [
        "run",
        "log"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "检查点、后处理与指标实现与报告版本一致；示例不经过选择性展示。",
        "en": "Checkpoint, post-processing and metric code match the reported version; examples are not cherry-picked."
      },
      "gateCommands": []
    },
    {
      "id": "validate",
      "layer": "L1",
      "order": 30,
      "name": {
        "zh": "验证",
        "en": "Validate"
      },
      "hint": {
        "zh": "执行预先定义的主指标、置信区间或重复试验、消融、强基线比较、鲁棒性检查与失败案例审查；区分验证集选择与测试集最终报告。",
        "en": "Run the pre-declared primary metric, CIs or repeats, ablations, strong baselines, robustness checks and failure review; separate validation-set selection from final test reporting."
      },
      "evidenceKinds": [
        "result",
        "ablation",
        "note"
      ],
      "requiresAnchor": true,
      "requiredFor": [
        "completion"
      ],
      "gate": {
        "zh": "主结果可重复；消融回答对应设计问题；统计结论符合样本量与检验假设。",
        "en": "Primary result reproducible; ablations answer their design question; statistics fit sample size and test assumptions."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/calibration_gates.py",
        "python skills/neural-paper-workflow/scripts/check_leakage.py"
      ]
    },
    {
      "id": "conclude",
      "layer": "L2",
      "order": 10,
      "name": {
        "zh": "总结",
        "en": "Conclude"
      },
      "hint": {
        "zh": "仅根据已验证证据给出结论，说明效应量、适用边界、局限性、负面结果与可复现条件；更新主张-证据映射。",
        "en": "Conclude only from validated evidence; state effect size, applicability bounds, limitations, negative results and reproducibility conditions; update the claim-evidence map."
      },
      "evidenceKinds": [
        "claim",
        "note"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "每个主要结论在 evidence-map.md 中有证据；限制和反例已记录。",
        "en": "Every main claim has evidence in evidence-map.md; limitations and counterexamples recorded."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_number_drift.py"
      ]
    },
    {
      "id": "write",
      "layer": "L2",
      "order": 20,
      "name": {
        "zh": "写作",
        "en": "Write"
      },
      "hint": {
        "zh": "以研究问题、方法、证据链与结论边界组织论文；为每个主要主张记录对应实验、图表、表格或引用。",
        "en": "Organize around question, method, evidence chain and claim bounds; record the experiment, figure, table or citation behind each main claim."
      },
      "evidenceKinds": [
        "draft",
        "note"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "图表、正文、附录和引用互相一致；未引入无证据的新主张。",
        "en": "Figures, body, appendix and citations agree; no new unsupported claims."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_citations.py",
        "python skills/neural-paper-workflow/scripts/check_tables.py",
        "python skills/neural-paper-workflow/scripts/check_pages.py"
      ]
    },
    {
      "id": "figure",
      "layer": "L3",
      "order": 10,
      "name": {
        "zh": "画图",
        "en": "Figures"
      },
      "hint": {
        "zh": "架构/机制/流程图用 figure_kit.py 生成 draw.io，导出 PDF/SVG/PNG 并用 figure_audit.py 审计几何与墨迹余量；数据图用 matplotlib 从冻结数据生成。",
        "en": "Generate architecture/mechanism figures as draw.io via figure_kit.py, export PDF/SVG/PNG and audit geometry and ink margin with figure_audit.py; data figures come from frozen data via matplotlib."
      },
      "evidenceKinds": [
        "figure",
        "note"
      ],
      "requiresAnchor": true,
      "requiredFor": [
        "completion"
      ],
      "gate": {
        "zh": "渲染产物经目视检查（NP603/NP604）；连线无交叉、箭头黑色且正交、语义与实现一致。",
        "en": "Rendered output visually inspected (NP603/NP604); no crossings, black orthogonal arrows, semantics match the implementation."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_figure_quality.py",
        "python skills/neural-paper-workflow/scripts/check_figure_rendering.py",
        "python skills/neural-paper-workflow/scripts/figure_audit.py"
      ]
    },
    {
      "id": "polish",
      "layer": "L3",
      "order": 20,
      "name": {
        "zh": "润色",
        "en": "Polish"
      },
      "hint": {
        "zh": "改善逻辑、术语一致性与学术表达，同时保持经验证数字、结论边界与引用不变。",
        "en": "Improve logic, terminology consistency and academic expression without changing verified numbers, claim bounds or citations."
      },
      "evidenceKinds": [
        "draft",
        "note"
      ],
      "requiresAnchor": false,
      "gate": {
        "zh": "未引入无法追溯的新主张、数值或引用；修改记录能说明受影响的证据。",
        "en": "No untraceable claims, numbers or citations introduced; the change log names the affected evidence."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_skill_style.py"
      ]
    },
    {
      "id": "submit",
      "layer": "L3",
      "order": 30,
      "name": {
        "zh": "投稿",
        "en": "Submit"
      },
      "hint": {
        "zh": "核对投稿清单、打包投稿包，经外部确认门后提交并记录。",
        "en": "Check the submission list, package the submission, pass the external confirmation gate, then submit and record it."
      },
      "evidenceKinds": [
        "submission",
        "completion"
      ],
      "requiresAnchor": true,
      "gate": {
        "zh": "投稿清单逐项核对；外部确认已取得；提交记录可追溯。",
        "en": "Submission list itemised; external confirmation obtained; submission recorded traceably."
      },
      "gateCommands": [
        "python skills/neural-paper-workflow/scripts/check_exports.py"
      ]
    }
  ],
  "edges": [
    {
      "from": "scope",
      "to": "develop",
      "port": "design"
    },
    {
      "from": "develop",
      "to": "train",
      "port": "code"
    },
    {
      "from": "train",
      "to": "infer",
      "port": "checkpoint"
    },
    {
      "from": "infer",
      "to": "validate",
      "port": "predictions"
    },
    {
      "from": "validate",
      "to": "conclude",
      "port": "results"
    },
    {
      "from": "conclude",
      "to": "write",
      "port": "claims"
    },
    {
      "from": "write",
      "to": "figure",
      "port": "manuscript"
    },
    {
      "from": "figure",
      "to": "polish",
      "port": "artifacts"
    },
    {
      "from": "polish",
      "to": "submit",
      "port": "final"
    }
  ]
}
