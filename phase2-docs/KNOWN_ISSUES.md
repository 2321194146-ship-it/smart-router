# 已知问题（Phase2-C 5% Live Pilot）

## Cloud Billing Blocker（保持不变，未修改）
`ExecutionEngine._recordCost()` 仍在 Finalize 原子事务【之前】写入成本记录。
5% Canary Live Pilot 阶段【明确不修改】此问题：
- 不阻塞内部 5% Canary（本地 Mock / 低额度测试链路，成本记录时序不影响实验结论）
- 在网站公开收费前【必须单独解决】（涉及 Phase1 CostTracker 与 Finalizer 的时序重构）
本阶段继续标记 Cloud Billing Blocker，不伪装成已解决。

## Responses 协议（进入维护清单，不阻塞本轮）
- 非流式 Responses 仍通过 Chat Adapter 间接执行；原始 text.format / json_schema 结构
  可能在转换前后丢失。
- 第一批真实 Canary 严格限制 Anthropic：Responses / Chat 暂不进入真实 Active Canary，
  继续使用 Shadow 或 Phase1 顺序。
- 本轮不修 Responses；进入后续维护清单，不阻塞 Claude Code Anthropic Canary。

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
- 5% Live Pilot 使用本地 Mock Anthropic Provider（真实 HTTP + SSE + SQLite 全链路），
  非真实外部 Provider；真实外部 Provider Pilot 仍待独立执行（不含任何 Key）。
