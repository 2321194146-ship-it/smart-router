# KNOWN_ISSUES（Smart Router Mainline - Phase 2-A Shadow）

本文件记录 Phase 2-A Shadow 版已知限制与后续处理建议。本阶段不进入 Active / 网站 / Dashboard / 收费。

## 1. 智能层未参与执行（Shadow 版边界）

- 现象：Decision Engine 的建议（recommendation）只记录，不改变实际路由。
- 影响：建议采纳率（当前真实运行 66.7%）仅为观测指标，不影响生产行为。
- 处理：Active 阶段需先评审 Policy 权重、淘汰规则与回滚机制，禁止自动学习直接修改生产权重。

## 2. 任务分析为启发式（无 LLM / 无 Tokenizer）

- 现象：Task Analyzer 用关键词信号 + 字符/3.5 估算 token，无真实 tokenizer。
- 影响：复杂自然语言请求的类型识别可能误判（如混合任务）。
- 处理：Shadow 版可接受；Active 前可引入轻量 tokenizer 或基于观测数据的校准。

## 3. 成本/质量/延迟预测为静态启发式

- 现象：predictLatency 含随机抖动（±400ms）；predictQuality 仅按 tier+复杂度。
- 影响：预测为粗粒度估计，非历史统计。
- 处理：Shadow Recorder 已积累真实 latency/quality/cost 数据，Active 前可用其校准。

## 4. Shadow 记录为内存存储

- 现象：ShadowRecorder 记录存于进程内存，重启丢失。
- 影响：观测数据不持久。
- 处理：后续可复用 Phase1 SQLite 事务基础设施持久化（本阶段保持最小侵入）。

## 5. 真实外部 Pilot 的端点约束

- 现象：Anthropic / Responses 经本地 7878 网关转发（环境标准路径），OpenAI 兼容 chat 直连 modelscope。
- 影响：Responses 上游偶发真实 429（Pilot 脚本已自动重试）；Anthropic 直连 api.anthropic.com 不通。
- 处理：已按环境约束完成真实 Pilot 9/9；网络/账号条件变化时可重跑。

## 6. cost 提前写入（execute 阶段 _recordCost）

- 现象：execution 在 execute 阶段直接 saveCost（usage 现已修复为真实 token），
  finalizeRequestAtomic 对已存在 cost 跳过。
- 影响：若 finalize 后续失败，cost 可能残留（不在 finalize 事务内）。
- 处理：属 Phase1 架构特性；Shadow 版不改变。后续可将 cost 写入移入 finalize 事务。

## 7. 客户端取消归因

- 现象：client_aborted 的 Attempt 标记为明确非质量结果，不计为模型质量失败。
- 影响：与 Phase1 语义一致。
- 处理：无需处理。
