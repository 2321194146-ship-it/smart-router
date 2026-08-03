# KNOWN_ISSUES（Smart Router Mainline - Phase 2-B Active Readiness）

本文件记录 Phase 2-B 已知限制与后续处理建议。本阶段不开启 Active；5% 低风险 Active 必须经独立验收。

## 1. 智能层未参与执行（Shadow 版边界）

- 现象：Decision Engine 的建议（recommendation）只记录，不改变实际路由。
- 影响：建议采纳率（评测 acceptance=exact_match 分母小）仅为观测指标，不影响生产行为。
- 处理：Active 阶段需先评审 Policy 权重、硬约束与回滚机制；禁止自动学习直接修改生产权重。

## 2. 任务分析为启发式（无 LLM / 无 Tokenizer）

- 现象：Task Analyzer 用关键词信号 + 字符/3.5 估算 token。
- 影响：评测 105 任务分类准确率 100%，但关键词变体（如 "give me a brief summary"）可能漏检；
  复杂混合任务可能误判。
- 处理：Active 前可引入轻量 tokenizer 或基于观测数据校准。

## 3. 成本/质量/延迟预测为确定性静态先验

- 现象：predictLatency 为 tier+provider 静态先验（无随机）；predictQuality 为能力匹配 + tier + reliability。
- 影响：预测为粗粒度估计，非历史统计。
- 处理：ShadowRecorder 已积累真实 latency/quality/cost 数据，Active 前可用其校准。

## 4. Provider 健康统计样本阈值（5）

- 现象：样本数 <5 时只用静态先验（reliability 配置）；>=5 才启用成功率/延迟修正。
- 影响：新 Provider 早期无健康修正，属保守行为（不剧烈调整）。
- 处理：阈值可配置化（当前硬编码 5）。

## 5. Phase1 候选构建仅识别旧 capability 数组

- 现象：`src/router/candidates.js` 的 `hasCapability` 只查 `model.capability` 数组；
  新 `capabilities` 对象需同时提供兼容数组（评测配置已自动生成）。
- 影响：生产配置若只用 capabilities 对象，Phase1 vision 过滤会失效（评测已用双格式规避）。
- 处理：Active 前可平滑升级 candidates.js 支持 capabilities 对象（属 Phase1 演进，本阶段未改）。

## 6. cost 提前写入（execute 阶段 _recordCost）

- 现象：execution 在 execute 阶段直接 saveCost，finalizeRequestAtomic 对已存在 cost 跳过。
- 影响：若 finalize 后续失败，cost 可能残留；Shadow 记录不依赖该路径。
- 处理：属 Phase1 架构特性；Shadow 版不改变。

## 7. 对照统计的 different 占比较高（评测 86/105）

- 现象：Shadow 推荐模型（能力优先）与 Phase1 实际执行模型（tier 优先）经常不同 → different。
- 影响：acceptance（exact_match）率低，但这是 Shadow 观测的预期差异，非缺陷；
  exact_match=5、model_match_provider_diff=0、policy_agreement=17、not_comparable=6、different=86。
- 处理：Active 阶段评估"建议-执行一致性"作为改进指标。

## 8. Shadow 观测记录未暴露查询 API

- 现象：shadow_decisions 表已持久化，但无对外查询接口。
- 处理：Dashboard/查询接口属后续阶段（不在 Phase2-B）。

## 9. 真实外部 Pilot 的端点约束

- 现象：Anthropic / Responses 经本地 7878 网关转发；OpenAI 兼容 chat 直连 modelscope。
- 处理：真实 Pilot 9/9 已完成；评测使用确定性本地 Mock（离线可复跑）。
