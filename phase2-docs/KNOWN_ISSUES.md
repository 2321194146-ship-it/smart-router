# KNOWN_ISSUES（Smart Router Mainline - Phase 2-A Shadow Sealed）

本文件记录 Phase 2-A Shadow Sealed 版已知限制与后续处理建议。本阶段不进入 Active / 网站 / Dashboard / 收费。

## 1. 智能层未参与执行（Shadow 版边界）

- 现象：Decision Engine 的建议（recommendation）只记录，不改变实际路由。
- 影响：建议采纳率（评测 76%、真实运行 66.7%）仅为观测指标，不影响生产行为。
- 处理：Active 阶段需先评审 Policy 权重、硬约束与回滚机制，禁止自动学习直接修改生产权重。

## 2. 任务分析为启发式（无 LLM / 无 Tokenizer）

- 现象：Task Analyzer 用关键词信号 + 字符/3.5 估算 token，无真实 tokenizer。
- 影响：评测 33 任务中 1 个分类偏差（summ-02 "Give me a brief summary" 未命中 extract 关键词，归为 chat），分类准确率 97%。
- 处理：Shadow 版可接受；Active 前可引入轻量 tokenizer 或基于观测数据校准。

## 3. 成本/质量/延迟预测为确定性静态先验

- 现象：predictLatency 为 tier+provider 静态先验（无随机）；predictQuality 按 tier+复杂度，上限 0.95。
- 影响：预测为粗粒度估计，非历史统计。
- 处理：ShadowRecorder 已积累真实 latency/quality/cost 数据，Active 前可用其校准（或接 ProviderHealth 历史均值）。

## 4. Shadow 观测记录未暴露查询 API

- 现象：shadow_decisions 表已持久化，但暂无对外查询接口（仅进程内 store 方法）。
- 影响：观测数据可通过 SQLite 直接查询，但无 HTTP/CLI 入口。
- 处理：Dashboard/查询接口属后续阶段（不在 Phase2-A）。

## 5. 真实外部 Pilot 的端点约束

- 现象：Anthropic / Responses 经本地 7878 网关转发（环境标准路径），OpenAI 兼容 chat 直连 modelscope。
- 影响：Responses 上游偶发真实 429（Pilot 脚本已自动重试）；Anthropic 直连 api.anthropic.com 不通。
- 处理：已按环境约束完成真实 Pilot 9/9；网络/账号条件变化时可重跑。

## 6. cost 提前写入（execute 阶段 _recordCost）

- 现象：execution 在 execute 阶段直接 saveCost，finalizeRequestAtomic 对已存在 cost 跳过。
- 影响：若 finalize 后续失败，cost 可能残留（不在 finalize 事务内）；Shadow 记录不依赖该路径（实际值来自 Audit attempts）。
- 处理：属 Phase1 架构特性；Shadow 版不改变。后续可将 cost 写入移入 finalize 事务。

## 7. 观察者基于内存快照匹配

- 现象：recordFinalized 通过内存 suggestion 快照（recordSuggestion 时同步写入）匹配 requestId；SQLite 同步写保证建议先于 finalize 落库。
- 影响：单进程语义正确（DatabaseSync 同步）；若未来多进程共享 DB，需改为从 DB 读取建议。
- 处理：当前单进程架构无此需求。

## 8. 协议适配兼容的 protocols 推导

- 现象：deriveProtocols 将 chat 能力模型视为三协议 adapter 兼容（responses/anthropic 内部转 chat 执行）。
- 影响：protocol 硬约束仅在模型无 chat 能力时触发（当前配置下几乎不触发，属正确语义）。
- 处理：Active 前若引入真正的协议级限制，可改为显式 protocols 配置。

## 9. 客户端取消归因

- 现象：client_aborted 的 Attempt 标记为明确非质量结果，Shadow comparison=not_comparable。
- 影响：与 Phase1 语义一致。
- 处理：无需处理。
