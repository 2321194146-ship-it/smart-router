# ACTIVE_READINESS_EVALUATION.md

Smart Router Mainline - Phase 2-B Active Readiness 评测报告

## 1. 评测方法

- 脚本：`scripts/active-readiness-eval.mjs`（可复跑、确定性）。
- 运行时：**确定性本地 Mock Provider**（可复现、离线、零成本）；验证 Shadow 决策/持久化/对照的
  真实代码路径（真实事务、真实 SQLite、真实协议执行）。
- 外部真实 Provider Pilot 证据见 `evidence/pilot-*.json`（ModelScope 直连；Anthropic/Responses 经 7878 网关）。
- 本阶段不开启 Active。

## 2. 任务矩阵（105 条固定脱敏任务）

覆盖 22 类场景：simple chat(6)、writing(5)、summarization(5)、translation(5)、extraction(5)、
analysis(5)、complex reasoning(5)、coding(6)、debugging(5)、architecture(4)、tool_use(5)、
vision(4)、structured output(5)、streaming(6)、long context(4)、strict(4)、allowPaid=false(4)、
maxRequestCost(4)、no_candidate(4)、fallback(4)、client_aborted(3)、incomplete(3)、
provider health change(4)。

每条任务定义：预期任务类型、必需硬能力、可接受模型集合、不允许模型集合、预算结果、
实际传统路由结果、Shadow 建议、比较状态（完整数据见 `active-readiness-eval-report.json`）。

## 3. 门禁结果（全部 PASS）

| 指标 | 要求 | 实际 |
| --- | --- | --- |
| 分类准确率 | >= 95% | 100%（105/105） |
| 硬能力违规 | 0 | 0 |
| Streaming 违规 | 0 | 0 |
| Vision 违规 | 0 | 0 |
| Tool 违规 | 0 | 0 |
| ContextWindow 违规 | 0 | 0 |
| 预算越权 | 0 | 0 |
| 禁付费越权 | 0 | 0 |
| strict 改变 | 0 | 0 |
| 可接受集合推荐 | >= 90% | 100% |
| 终态一致率 | — | 100%（105/105） |
| Prompt 注入 / 消息改写 | 0 | 0 |

## 4. 场景要点

- **complex reasoning**：5 条任务全部推荐 M-reason（reasoning 模型），优于普通 chat 模型。
- **coding/debugging**：推荐 coding 能力模型（M-coding/M-stream），debugging 额外要求 reasoning 高分。
- **summarization**：reasoning 需求 0.3（低），成本优先（免费 chat 模型）。
- **streaming**：6 条流式任务全部推荐 streaming 模型；nostream 候选 blocked。
- **vision**：4 条任务全部推荐 M-vision；非 vision 候选 blocked。
- **tool_use**：推荐 tool_use 模型；无 tool_use 能力候选 blocked。
- **long context**：M-smallctx（context 500）被 contextWindow 硬约束淘汰。
- **strict / no_candidate**：8 条任务 recommendation=null，实际 no_candidate，policy_agreement。
- **allowPaid=false**：4 条任务推荐免费模型，无禁付费越权。
- **maxRequestCost**：4 条任务全部候选超限 → recommendation=null + wouldBlockAll=true，无预算越权。
- **fallback**：真实 500 → fallback 成功（completed），Shadow 记录完整。
- **client_aborted / incomplete**：实际终态分别为 client_aborted / incomplete，与预期一致。

## 5. 数据文件

- `evidence/active-readiness-eval-report.json`：105 条完整数据（含每任务 acceptable/forbidden/建议/真实结果/比较状态）。
- `evidence/active-readiness-eval-report.md`：可读报告（门禁明细 + 前 30 行明细）。

## 6. 复跑

```bash
node scripts/active-readiness-eval.mjs
```
