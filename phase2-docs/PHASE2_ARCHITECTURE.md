# PHASE2_ARCHITECTURE.md

Smart Router Mainline - Phase 2-A（智能决策 Shadow 版）架构说明
分支：`phase2-shadow` ｜ 基线：`feb735d`（Phase1 正式封板）＋ `247495b`（Pilot 修复）

## 1. 定位与边界

Phase 2-A 在 Phase1 生产执行底座之上新增「智能决策层」的 **Shadow 版本**：
只观察、只建议、只记录，**不参与执行**。Active（全流量生效）、Dashboard、网站、
用户系统、商业化、Prompt 注入、用户消息改写、Tool 自动控制、多模型并行竞速、
多模型内容拼接、自动学习直接修改生产权重——全部不在本阶段范围。

## 2. 分层结构

```text
┌────────────────────────────────────────────────────────────┐
│ 协议层 (chat / responses / anthropic)                       │
│   — 4b. Shadow 观测 hook（execute 后插入）                  │
└──────────────────────────┬─────────────────────────────────┘
                           │ suggest() / recordTraditional()
┌──────────────────────────▼─────────────────────────────────┐
│ IntelligenceLayer (src/intelligence/index.js)              │
│   mode: off | shadow（配置 intelligence.mode）              │
│   ├─ DecisionEngine ── Task Analyzer                       │
│   │                  ├─ Capability Registry                │
│   │                  ├─ Policy                             │
│   │                  └─ Budget                             │
│   ├─ Explainability（决策解释）                              │
│   └─ ShadowRecorder（记录 + 对照摘要）                       │
└──────────────────────────┬─────────────────────────────────┘
                           │ 只读 config / 请求体，纯本地计算
┌──────────────────────────▼─────────────────────────────────┐
│ Phase1 执行底座（ExecutionEngine / Finalizer / SQLite）     │
│   真实路由选择、usage、成本、Attempt 记录（不受 Shadow 影响）│
└────────────────────────────────────────────────────────────┘
```

## 3. 模块职责

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Agent Identity | `src/agent/identity.js`（复用 Phase1） | agentId 解析、模型池/预算绑定 |
| Task Analyzer | `src/intelligence/task-analyzer.js` | 任务画像：类型/复杂度/上下文/工具/视觉需求 |
| Capability Registry | `src/intelligence/capability-registry.js` | 模型能力注册与查询（chat/tool_use/vision/streaming） |
| Policy | `src/intelligence/policy.js` | 候选评分规则（能力/tier/免费/成本）与预测 |
| Budget | `src/intelligence/budget.js` | Shadow 预算画像（预估成本/付费/allowlist/是否全堵） |
| Decision Engine | `src/intelligence/decision-engine.js` | 组合以上模块，输出推荐+排序+预测+解释 |
| Explainability | `src/intelligence/explainability.js` | 决策解释（推荐原因/淘汰原因/预测摘要） |
| Shadow Recorder | `src/intelligence/shadow-recorder.js` | 记录智能建议与真实选择，生成对照摘要 |
| IntelligenceLayer | `src/intelligence/index.js` | off/shadow 模式入口 |

## 4. Shadow 模式硬约束（实现保证）

1. **不增加上游调用**：IntelligenceLayer 全部为纯本地计算（无 fetch / 无网络）。
2. **不修改 Phase1 候选顺序**：Decision Engine 只读 `candidates`，排序仅存在于输出元数据。
3. **不影响用户响应**：hook 包在 try/catch 中，任何 Shadow 异常都被吞掉；off 模式直接返回。
4. **记录传统路由真实选择**：`recordTraditional` 记录 final provider/model/outcome/latency/usage/cost。
5. **记录智能建议**：`suggest` 记录 recommendation/ranked/predictions/explanation。
6. **记录预测**：成本、质量、延迟预测（Policy 的启发式）。
7. **记录选择与淘汰原因**：Explainability 生成 `eliminated`（含 blocked/低分原因）。
8. **三协议同一 requestId**：hook 使用 server 生成的内部 `sr_` requestId（context.requestId）。
9. **可立即切回 off**：配置 `intelligence.mode: "off"` 即恢复 Phase1 行为（validator 已允许 off/shadow）。

## 5. 模式语义

| 模式 | 执行路径 | Shadow 记录 | 开销 |
| --- | --- | --- | --- |
| `off` | Phase1 完全一致 | 无 | 零（hook 直接跳过） |
| `shadow` | Phase1 完全一致 | 记录建议+真实选择 | 纯本地计算（毫秒级） |

## 6. 接入点（最小侵入）

- `src/server.js`：创建 `IntelligenceLayer`，加入 components，注入 context。
- 5 个协议处理器（chat / chat-stream / responses-stream / anthropic / anthropic-stream）：
  在 `executionEngine.execute()` 返回后插入「4b. Shadow 观测」hook：
  `suggest(...)` 生成建议 → `recordTraditional(...)` 记录真实结果。
- `src/config/validator.js`：`intelligence.mode` 允许 `shadow`。

## 7. 智能输出（机器可执行元数据，不含 System Prompt）

```json
{
  "mode": "shadow",
  "task": { "taskType": "coding", "complexity": 0.7, "needsToolUse": false },
  "budgetAssessment": { "allowPaid": false, "wouldBlockAll": false, "estimatedCost": 0 },
  "recommendation": { "modelId": "m1", "provider": "p1", "score": 0.85 },
  "ranked": [ { "modelId": "m1", "score": 0.85, "reasons": ["tier=tier1"] } ],
  "predictions": { "cost": 0, "quality": 0.9, "latency": 1200 },
  "explanation": { "summary": "推荐 p1/m1（score=0.85）；淘汰 2 个候选", "eliminated": [...] }
}
```

智能层**不附加任何 System Prompt**，不修改消息内容。
