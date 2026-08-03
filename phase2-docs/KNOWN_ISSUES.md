# 已知问题（Phase2-C）

## Cloud Billing Blocker（未解决，明确标记）
`ExecutionEngine._recordCost()` 仍在 Finalize 原子事务【之前】写入成本记录。
本阶段【不得伪装成已经解决】；成本入账的时序问题与对账方案为独立设计任务：
- Provider 实际成本（usage 回填）与内部预估成本的对账
- 最终状态（completed/incomplete/budget_exceeded）与成本记录的一致性
- retry / fallback 多跳成本归属
- Finalize 失败时的成本记录补偿
该问题的解决涉及 Phase1 CostTracker 与 Finalizer 的时序重构，超出 Phase2-C 范围。

## 其他已知限制
- `responses.js`（非流式 Responses 适配器）未接入 Shadow/Canary 3b 钩子
  （Phase2-B 既有状态）；responses-stream.js 已接入。
- Canary 采样依赖 requestId（服务端生成）；客户端自定义 x-request-id 仅作为
  externalRequestId 透传，不参与采样。
- resolveAgent 仅识别 claude-code / codex / openai-sdk / generic 四类 agentId；
  "test-agent-1" 等自定义 agent 需扩展 resolveAgent 或使用现有 agent 标识。
- Token 估算为保守上界（CJK 1.5/字、安全余量 1.1），可能高于真实 tokenizer 计数；
  预算与上下文判定倾向安全侧。
- 分类器为关键词+正则启发式；极冷门的同义表达可能回落 general_chat（Holdout 208 任务
  当前 100% 覆盖，但不能保证任意输入）。
