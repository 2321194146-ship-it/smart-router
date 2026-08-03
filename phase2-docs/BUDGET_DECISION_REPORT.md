# BUDGET_DECISION_REPORT.md

Smart Router Mainline - Phase 2-B Budget 决策修复报告

## 1. 已复现问题（修复前）

```text
maxRequestCost = 0.000001
推荐预计费用 = 0.246
→ 仍然推荐
```

根因：Decision Engine 只读取候选顶层字段（缺失），且 maxRequestCost 不作为硬约束。

## 2. 修复

### 2.1 每候选独立成本计算

每个标准化候选先用**自己的 price** 计算 `estimatedCost`（`estimateCost(candidate, task)`）：

```text
estimatedCost = inputTokens/1000 × input_cost_per_1k
              + outputTokens/1000 × output_cost_per_1k
```

输入 token 来自任务画像（字符/3.5 估算），输出 token 按复杂度估算。

### 2.2 超预算硬约束

```text
estimatedCost > maxRequestCost
→ blocked = "request_cost_exceeded (estimated X > maxRequestCost Y)"
```

本阶段无超预算审批，默认必须阻止。被阻止候选 score=0，绝不能成为 recommendation。

### 2.3 全部超预算

```text
全部候选超预算
→ recommendation = null
→ budgetAssessment.wouldBlockAll = true
→ budgetAssessment.estimatedCost = null
```

### 2.4 统一数据源

Budget 评估（`evaluateBudget`）与 Policy 评分（`budgetBlock`）使用**同一套标准化画像**（price/paid/modelId/provider），不再读取错误的候选顶层字段。修复项：

- `budgetAssessment.estimatedCost`：取通过预算检查候选中的最低成本
- `wouldBlockAll`：全部被预算阻止 → true
- recommendation 成本：推荐候选（modelId+provider）对应成本，有价格配置非 null
- allowedModels / allowedProviders / allowPaid / strictModel / maxRequestCost：全部从配置正确解析（agent 覆盖全局）

## 3. Shadow 对照语义

Shadow 建议 = null 且实际结果为 budget_exceeded / no_candidate → `policy_agreement`（双方都拒绝），
不再统计为"不一致"。

## 4. 测试证据

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| maxRequestCost=0.000001 + 付费候选 | recommendation=null，blocked 含 request_cost_exceeded，wouldBlockAll=true | ✅ |
| 混合候选（免费 + 超限付费） | 免费候选可推荐，estimatedCost=0，blockedCandidates 列出超限者 | ✅ |
| allowPaid=false + 付费候选 | blocked 含 allowPaid=false | ✅ |
| 评测 105 任务（budget 阶段 4 条） | 预算越权推荐 = 0 | ✅ |

## 5. 评测证据（ACTIVE_READINESS_EVALUATION.md）

maxRequestCost 阶段 4 条任务全部 `recommendation=null`（paidOnly 模型全超限），
`budgetAssessment.wouldBlockAll=true`，预算越权推荐 = 0。
