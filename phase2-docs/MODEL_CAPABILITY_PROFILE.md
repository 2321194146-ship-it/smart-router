# MODEL_CAPABILITY_PROFILE.md

Smart Router Mainline - Phase 2-B 标准化 Model Capability Profile

## 1. 画像结构

```json
{
  "modelId": "M-reason",
  "provider": "mock",
  "capabilities": {
    "chat": 1.0,
    "coding": 0.8,
    "reasoning": 1.0,
    "tool_use": 0.0,
    "vision": 0.0,
    "structured_output": 0.8,
    "long_context": 0.8,
    "streaming": 1.0
  },
  "contextWindow": 64000,
  "price": { "input_cost_per_1k": 0.005, "output_cost_per_1k": 0.01 },
  "tier": "tier2",
  "paid": true,
  "reliability": 0.95,
  "latencyPriorMs": 1400,
  "protocols": ["chat", "responses", "anthropic"]
}
```

## 2. 规范化规则

- **能力分**：管理员可用 0-1 或 0-100，内部统一规范化为 0-1（`normalizeCapabilityScore`：>1 视为 0-100 分制除以 100；<=1 直接采用）。
- **兼容旧配置**：`capability: ['chat', 'tool_use', ...]` 字符串数组 → 对应能力 = 1.0；未声明能力数组/对象时默认仅 chat=1.0。
- **统一身份**：`modelId + provider`；同一个 modelId 不同 Provider 保留独立画像（价格/能力/可靠性均可不同）。

## 3. 字段来源

| 字段 | 配置键 |
| --- | --- |
| capabilities | `capabilities` 对象（0-1/0-100）或 `capability` 数组（兼容） |
| contextWindow | `context_window`（优先）或 `max_tokens` |
| price | `price` |
| tier / paid | `tier` / `paid` |
| reliability | `reliability`（0-1/0-100 规范化） |
| latencyPriorMs | `latency_prior_ms` / `latencyPriorMs` |
| protocols | `deriveProtocols`：chat 能力模型经适配层兼容三协议；gateway provider 原生支持 |

## 4. 处理能力

tool_use、vision、streaming、contextWindow、Chat、Responses、Anthropic 全部纳入画像；
硬约束检查（`hardConstraintBlock`）对缺失能力的候选直接 blocked。

## 5. 测试证据

- 0-100 规范化：chat=100 → 1.0，reasoning=30 → 0.3。
- 旧数组兼容：`capability: ['chat']` → chat=1.0，tool_use=0。
- 同 modelId 不同 Provider：mx/pA vs mx/pB 的 reasoning/价格/可靠性独立。
- reliability、latencyPriorMs、contextWindow、protocols 正确读取。
