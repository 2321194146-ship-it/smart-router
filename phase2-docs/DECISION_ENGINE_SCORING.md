# DECISION_ENGINE_SCORING.md

Smart Router Mainline - Phase 2-A Decision Engine 评分说明

## 1. 评分公式

对每个候选模型计算综合评分（0-1）：

```text
score = capScore × capabilityWeight(0.35)
      + tierScore × tierWeight(0.25)
      + paidScore × 0.15
      + costScore × costWeight(0.25)
```

| 分量 | 规则 |
| --- | --- |
| capScore | 任务需要 tool_use/vision 且候选具备 → 1.0；缺失 → 0.2；无需求 → 0.5 |
| tierScore | tier1=1.0、tier2=0.7、tier3=0.4 |
| paidScore | 免费=1.0；付费=0.8（paidPenalty=0.2） |
| costScore | price 越低越高（`max(0, 1 - (in + 3×out)/0.05)`）；无价格=0.5 |

硬性淘汰（score=0 + blocked 原因）：allowPaid=false 且 paid、不在 allowedModels、
不在 allowedProviders、预估成本超 maxRequestCost。

## 2. 预测

| 预测 | 方法 |
| --- | --- |
| 成本 | 输入 token（任务画像）× 输入单价 + 输出 token（复杂度）× 输出单价 |
| 质量 | tier 基准 + 任务复杂度加成（复杂任务更偏好 tier1） |
| 延迟 | tier 基准（tier1=1200ms、tier2=1800ms、tier3=2400ms）+ 抖动 |

## 3. 测试断言（test/unit/intelligence.test.js）

| 用例 | 结果 |
| --- | --- |
| 推荐应为 free + 能力匹配的 m1（3 候选） | ✅ recommendation=m1 |
| 全部被预算阻止时 recommendation=null | ✅ |
| free+tier1 评分 > paid+tier2 | ✅ |
| 淘汰原因含 "tool_use" | ✅ |
| 预测质量/延迟有界 | ✅ |

## 4. Shadow 真实运行（shadow-run-report.json）

| 场景 | 推荐 | 评分 | 真实选择 | 一致 |
| --- | --- | --- | --- | --- |
| coding 任务 | deepseek-ai/DeepSeek-V4-Flash | 0.70 | modelscope/deepseek | ✅ |
| anthropic 解释 | gateway-auto | 高 | gateway/gateway-auto | ✅ |
| responses 摘要 | gateway-auto | 高 | gateway/gateway-auto | ✅ |
| paid_blocked | null（预算阻止） | — | 402 budget_exceeded | ✅ 语义一致 |

## 5. 设计说明

- 评分为启发式（Shadow 版），无学习权重；后续 Active 阶段的权重更新必须经人工审核，
  本阶段**禁止自动学习直接修改生产权重**。
- 排序仅存在于输出元数据，Phase1 候选顺序不被修改。
