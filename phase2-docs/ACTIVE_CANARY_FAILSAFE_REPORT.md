# Active Canary 指标与自动停止报告（Phase2-C 第 9 节）

## 指标（CanaryController.metrics）
eligible（可采样请求数）/ sampled（采样命中）/ active（实际重排）/ activeVsPhase1
（same/diff）/ cost（累计成本）/ quality / incomplete / failed / aborted / attempts /
fallbackCount / paidRatio / decisionLatencyMs / autoStop（原因与时间）。

## 自动停止（命中即回退 shadow 行为，后续不再采样）
| 条件 | 触发 |
| --- | --- |
| 预算违规（budget_exceeded） | 停止 |
| 预算防御（重排 primary 违反 allowPaid/allowed 列表） | 停止（apply 时） |
| incomplete 上升（>=3 次） | 停止 |
| 连续 provider 错误（failed >=3） | 停止 |
| 连续无候选（failed >=3） | 停止 |
| Kill Switch（显式 / 配置） | 停止 |

## Fail Open 保障
- apply() 异常 → Phase1 顺序。
- 协议层 suggest 异常 → 保持 Phase1 候选（既有 shadow_error 日志链）。
- 自动停止后所有请求走 Phase1（active=false, reason='killed'）。

## 验证
- 单元测试：kill switch、预算违规自动停止、incomplete_rise 自动停止、Fail Open、禁用态。
- 端到端：active_canary 模式真实重排且执行成功；shadow 模式不重排。

## 生产约束
本阶段仅实现并测试自动停止；不实际开启 5% 流量。Active 默认关闭（mode=off/shadow）。
