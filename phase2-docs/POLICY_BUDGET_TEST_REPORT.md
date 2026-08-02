# POLICY_BUDGET_TEST_REPORT.md

Smart Router Mainline - Phase 2-A Policy 与 Budget 测试报告

## 1. Policy（基础路由策略）

### 规则集

- `tierPreference`：tier1 优先（tier 评分权重 0.25）
- `preferFree`：免费优先（paidPenalty=0.2）
- `capabilityWeight`：能力匹配权重 0.35
- `costWeight`：成本评分权重 0.25

### 测试（test/unit/intelligence.test.js）

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| normalizePolicy 默认值 | tierPreference/preferFree=true | ✅ |
| allowPaid=false + paid 候选 | score=0 + blocked 含 "allowPaid=false" | ✅ |
| 不在 allowedModels | score=0 + blocked 含 "allowedModels" | ✅ |
| free+tier1 > paid+tier2 | 评分严格大于 | ✅ |
| 预测有界 | quality∈[0,1]、latency>0 | ✅ |

## 2. Budget（Shadow 预算评估）

### 画像字段

- allowPaid / maxRequestCost / allowedModels / allowedProviders / strictModel
- estimatedCost（候选中最便宜付费价预估）
- paidCandidates / freeCandidates
- wouldBlockAll（预算是否阻止所有候选 + 原因）

### 测试

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 仅付费候选 + allowPaid=false | wouldBlockAll=true，原因含 allowPaid=false | ✅ |
| 有价格候选 | estimatedCost > 0 | ✅ |
| agent 预算覆盖全局 | allowPaid 取 agent 值 | ✅ |

## 3. 与 Phase1 CostTracker 的关系

| 层 | 角色 | 是否拦截 |
| --- | --- | --- |
| Phase1 CostTracker | 生产硬性安全闸门（budget_exceeded → 402） | 是 |
| Phase2 Budget | Shadow 预算画像（仅建议与记录） | 否 |

Shadow Budget 只读配置 + 纯本地计算，不发起上游调用、不拦截执行。
