# PROVIDER_HEALTH_SCORING.md

Smart Router Mainline - Phase 2-B Provider 健康与可靠性评分

## 1. 设计原则

Decision Engine 对 ProviderHealth / CircuitBreaker **只读使用**：

- 已熔断（OPEN）或不可用（DOWN）的候选**继续由 Phase1 候选生成层排除**（不在本层重复处理）；
- 可用但近期不稳定的 Provider **降低评分**（不排除）；
- **不允许**健康统计扩大合法候选集合；
- **不允许** Shadow 修改 Provider 状态（无任何写调用）；
- 初始样本不足时**只用静态先验**，不做剧烈调整。

## 2. 数据来源（只读）

```js
health.getHealthSummary()  // { provider: { status, avgLatency, totalRequests, totalFailures, ... } }
```

注入方式：`server.js` 将 ProviderHealth 实例传给 `IntelligenceLayer({ store, health })` → `DecisionEngine({ health })`。

## 3. 评分规则

| 样本数 | 规则 |
| --- | --- |
| < 5 | 只用静态先验（reliability 配置 + 默认），不因健康统计剧烈调整 |
| >= 5 | 成功率 + 状态修正：`relScore = min(relScore, 0.7 + (1-failureRate)*0.3)`；degraded 再 -0.15；down 再 -0.4 |

reliability 配置（0-1）参与基准：`relScore = 0.5 + reliability*0.5`。

## 4. 延迟预测（确定性）

```text
latencyPriorMs（配置）> 静态先验（tier 基准 + provider 偏移）> 健康历史均值（样本 >= 5 时取先验与均值的平均）
```

无 `Math.random()`：相同输入、相同状态 → 相同输出。

## 5. 约束验证（评测）

- health 阶段：先注入 6 次上游 500 使 mock-fail Provider 降级；
  随后 4 条常规任务推荐**未扩大**合法候选集合（推荐仍为配置内免费 chat 模型，可接受率 100%）。
- 评测 Provider 健康变化 4 条任务全部通过（硬违规 0）。

## 6. 测试证据

- `predictLatency` 确定性：相同候选两次调用结果一致。
- 样本阈值：sampleCount=2 与 10 的延迟预测来源不同（<5 用静态先验）。
- Decision Engine 评分：不稳定 Provider（高 failureRate / degraded）relScore 降低。
