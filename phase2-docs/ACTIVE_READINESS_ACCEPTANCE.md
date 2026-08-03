# ACTIVE_READINESS_ACCEPTANCE.md

Smart Router Mainline - Phase 2-B：Decision Engine Active Readiness 验收报告
版本：`1.0.0-phase2-shadow` ｜ 分支：`phase2-shadow` ｜ 基线：`09d91cc`（npm test 480/480 确认）
提交：见 `evidence/git-commit-sha.txt`

## 1. 范围与边界

本阶段把 Shadow 观测系统升级为具备真实任务能力匹配和预算控制能力的决策系统。
**系统继续运行 `intelligence.mode = shadow`，不开启真实 Active 流量。**
未实现：Active、Dashboard、网站、用户系统、商业化、Prompt 注入、用户消息改写、
Tool 自动控制、多模型并行/拼接、自动学习修改生产权重。

## 2. 交付内容（与需求一一对应）

| # | 需求 | 实现 | 证据 |
| --- | --- | --- | --- |
| 一 | 统一任务能力需求画像 | Task Analyzer 新增 `requiredCapabilities`（8 能力 0-1）+ 13 任务类型 + streaming 硬性 | TASK_CAPABILITY_MODEL.md + 单测 |
| 二 | 扩展 Model Capability Profile | Registry `getProfile` 输出 capabilities 对象（0-100 规范化 0-1）+ reliability + latencyPriorMs + 兼容旧数组 | MODEL_CAPABILITY_PROFILE.md |
| 三 | 修复 Streaming 硬约束 | stream=true + 无 streaming → blocked（三协议流式全覆盖；非流式不阻止） | 集成测试 1a-1d |
| 四 | 任务能力参与评分 | 能力匹配主导（0.55）+ 强需求缺失惩罚 + 动态成本权重 | 单测：reasoning/coding/成本优先 |
| 五 | 彻底修复 Budget | request_cost_exceeded 硬约束 + 标准化 price + wouldBlockAll + recommendation 成本 | BUDGET_DECISION_REPORT.md |
| 六 | Provider 健康与可靠性 | 只读 ProviderHealth；不稳定降分；样本<5 静态先验；不扩大候选 | PROVIDER_HEALTH_SCORING.md |
| 七 | Shadow 异步异常隔离 | 方案A：await + try/catch + log shadow_error；suggest 落库后才 Finalize | ASYNC_FAILURE_ISOLATION_REPORT.md |
| 八 | Active Readiness 评测集 | 105 条固定脱敏任务，覆盖 22 类场景 | ACTIVE_READINESS_EVALUATION.md + 100+ 数据 |
| 九 | Active 门禁指标 | 全部达标（见下） | 本文件第 3 节 |
| 十 | 修复发布清单 | 3 个不一致已修复；Manifest 不含自身 Hash | RELEASE_MANIFEST.json |

## 3. Active 门禁指标（105 条评测，全部通过）

| 指标 | 要求 | 实际 | 结果 |
| --- | --- | --- | --- |
| 任务分类准确率 | >= 95% | 100%（105/105） | ✅ |
| 硬能力违规推荐 | 0 | 0 | ✅ |
| Streaming 能力违规 | 0 | 0 | ✅ |
| Vision 能力违规 | 0 | 0 | ✅ |
| Tool 能力违规 | 0 | 0 | ✅ |
| ContextWindow 违规 | 0 | 0 | ✅ |
| 预算越权推荐 | 0 | 0 | ✅ |
| 禁付费越权推荐 | 0 | 0 | ✅ |
| strict 模型改变 | 0 | 0 | ✅ |
| 推荐在可接受集合 | >= 90% | 100% | ✅ |
| Prompt 注入 | 0 | 0（代码审查 + grep 验证） | ✅ |
| 用户消息改写 | 0 | 0 | ✅ |

终态一致率（真实 Shadow 结果 vs 预期）：100%（105/105）。
对照统计：exact_match=5，policy_agreement=17，different=86，not_comparable=6（数据见报告 JSON）。

## 4. 关键设计决策

- **评分**：能力匹配权重 0.55（主导），tier 0.06（辅助），成本 0.32 且按复杂度动态（复杂任务降成本权重、简单任务成本优先）；强需求（>=0.7）模型能力不足即惩罚。不把 tier 当作唯一质量替代品。
- **硬约束优先于评分**：streaming/tool_use/vision/contextWindow/protocol/request_cost_exceeded 缺失 → score=0 + blocked，绝不成为 recommendation。
- **成本**：每个候选按标准化画像 price 独立计算；recommendation 成本 = 推荐候选（modelId+provider）对应成本；有价格配置非 null。
- **Provider 健康只读**：Decision Engine 通过 `getHealthSummary()` 读取，不修改 Provider 状态；样本 <5 只用静态先验；不稳定 Provider 降分但不得扩大合法候选集合。
- **异步隔离**：协议层 await suggest()，try/catch + `shadow_error` 日志；suggestion 落库后 Execution 才可能 Finalize（DB 写失败测试证明用户请求/Phase1 路由不受影响、无半条记录）。

## 5. 验证命令

```bash
node scripts/active-readiness-eval.mjs   # 105 任务评测（门禁全 PASS）
npm test                                  # 500/500
npm run test:unit                         # 387/387
npm run test:integration                  # 80/80
npm run test:audit                        # 33/33
npm run syntax:check                      # 通过
```

## 6. 后续（禁止在本阶段执行）

5% 低风险 Active 必须经**独立验收**后开启。本阶段完成后停止。
