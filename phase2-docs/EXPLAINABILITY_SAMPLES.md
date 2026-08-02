# EXPLAINABILITY_SAMPLES.md

Smart Router Mainline - Phase 2-A Explainability 样例

Explainability 为每次智能决策生成机器可读解释：推荐原因、淘汰原因、预测摘要。
样例均来自真实运行（shadow-run-report.json）与单元测试。

## 1. 真实运行样例

### 样例 A：coding 任务（chat，建议被采纳）

```json
{
  "recommendation": { "modelId": "deepseek-ai/DeepSeek-V4-Flash", "provider": "modelscope", "score": 0.7 },
  "predictions": { "quality": 0.95, "latency": 1500 },
  "eliminated": [],
  "summary": "推荐 modelscope/deepseek-ai/DeepSeek-V4-Flash（score=0.7）；预估质量 0.95；预估延迟 1500ms"
}
```

原因链：`tier=tier1`、`free model preferred`、`has tool_use (required)`。

### 样例 B：paid_blocked（预算阻止，无推荐）

```json
{
  "recommendation": null,
  "eliminated": [ { "modelId": "paid-model", "reason": "paid model blocked by allowPaid=false" } ],
  "summary": "无推荐（所有候选被预算/策略淘汰）；淘汰 1 个候选"
}
```

## 2. 单元测试样例

```json
{
  "recommendation": { "modelId": "m1", "provider": "p1", "score": 0.9 },
  "eliminated": [
    { "modelId": "m3", "score": 0.4, "reason": "missing tool_use (required)" }
  ],
  "summary": "推荐 p1/m1（score=0.9）；淘汰 1 个候选"
}
```

## 3. 淘汰原因类型

| 类型 | 触发 | 示例 |
| --- | --- | --- |
| 预算阻止 | allowPaid=false / allowlist / 超成本 | "paid model blocked by allowPaid=false" |
| 能力缺失 | 任务需 tool_use/vision 而模型无 | "missing tool_use (required)" |
| 评分较低 | 分数低于推荐 | "lower score (0.4) than recommendation (0.9)" |
| 未选中 | 分数相同但排序靠后 | "not selected" |

## 4. 设计说明

- 解释由**结构化模板**生成（非 LLM），确定性强、可测试、零上游调用。
- 解释随 Shadow 记录绑定 requestId，可回溯到真实选择。
