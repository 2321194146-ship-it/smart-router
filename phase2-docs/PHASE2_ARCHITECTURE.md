# PHASE2_ARCHITECTURE.md

Smart Router Mainline - Phase 2-A（智能决策 Shadow 版）架构说明（Sealed）
分支：`phase2-shadow` ｜ 基线：`feb735d`（Phase1 封板）＋ Pilot 修复 `247495b`

## 1. 定位与边界

Phase 2-A 在 Phase1 生产执行底座之上新增「智能决策层」的 **Shadow 版本**：只观察、只建议、只记录，**不参与执行**。
Active（全流量生效）、Dashboard、网站、用户系统、商业化、Prompt 注入、用户消息改写、
Tool 自动控制、多模型并行竞速、多模型内容拼接、自动学习直接修改生产权重——全部不在本阶段范围。

## 2. 正确运行顺序（Sealed）

```text
候选生成
→ Intelligence.suggest()          （执行前生成并持久化智能建议）
→ Phase1 Execution                （传统路由，串行 Fallback）
→ 协议验证 / 流式完成
→ Finalize 原子提交               （finalizeRequestAtomic，BEGIN IMMEDIATE）
→ Intelligence.recordFinalized()  （Finalizer 观察者，仅在事务成功后触发）
```

- 协议层**不再**在 `executionEngine.execute()` 返回时记录真实结果。
- 真实结果**只来自最终 Audit**（Finalizer 观察者收到 auditRecord 后回填）。
- 观察者钩子失败不影响用户请求与 Phase1 执行结果（Finalizer 内部异常隔离）。

```js
// Finalizer（src/runtime/finalization.js）
finalizer.addObserver(async (auditRecord) => {
  intelligence.recordFinalized(auditRecord); // 事务已提交后触发
});
```

## 3. 分层结构

```text
协议层 (chat / chat-stream / responses-stream / anthropic / anthropic-stream)
  ├─ 3b. suggest()（执行前；无候选/预算拦截也记录）
  └─ 调用 executionEngine.execute() → handleSuccess/Failure → finalizeRequestTransaction
                     │
                     ▼（事务成功后观察者）
IntelligenceLayer (src/intelligence/index.js)
  ├─ DecisionEngine ── Task Analyzer
  │                  ├─ Capability Registry（modelId+provider 画像）
  │                  ├─ Policy（硬约束 + 评分）
  │                  └─ Budget（Shadow 评估）
  ├─ Explainability
  └─ ShadowRecorder ── SQLite shadow_decisions（建议 upsert + 最终更新）
```

## 4. 模块职责

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Agent Identity | `src/agent/identity.js`（复用 Phase1） | agentId 解析、模型池/预算绑定 |
| Task Analyzer | `src/intelligence/task-analyzer.js` | 任务画像：类型/复杂度/上下文/工具/视觉 |
| Capability Registry | `src/intelligence/capability-registry.js` | 模型能力注册（modelId+provider）、contextWindow、price、protocols |
| Policy | `src/intelligence/policy.js` | 硬约束（tool_use/vision/contextWindow/protocol）+ 评分 + 确定性预测 |
| Budget | `src/intelligence/budget.js` | Shadow 预算画像（预估成本/付费/allowlist/wouldBlockAll） |
| Decision Engine | `src/intelligence/decision-engine.js` | 组合以上模块，输出推荐+排序+预测+解释 |
| Explainability | `src/intelligence/explainability.js` | 决策解释（推荐/淘汰原因/预测摘要） |
| Shadow Recorder | `src/intelligence/shadow-recorder.js` | 建议与最终结果持久化 + 对照状态机 |
| IntelligenceLayer | `src/intelligence/index.js` | off/shadow 模式入口 + Finalizer 观察者 |

## 5. 硬约束（不是普通评分项）

| 约束 | 规则 | blocked 示例 |
| --- | --- | --- |
| tool_use | 任务需要而模型不支持 | `missing tool_use (required)` |
| vision | 任务需要而模型不支持 | `missing vision (required)` |
| contextWindow | 预估输入 token 超模型上下文 | `input tokens 4300 > contextWindow 500` |
| protocol | 协议无法 native/adapter 兼容 | `protocol "responses" not supported` |

被硬约束阻止的候选：`score=0` + `blocked` 原因，**绝不能成为 recommendation**。
（注：chat 能力模型经协议适配层可服务全部三协议；`deriveProtocols` 已按 adapter 兼容实现。）

## 6. 预测（确定性）

- 成本：每个候选按自己的 `price` 计算 `estimateCost`；`predictions.cost` = 推荐候选（modelId+provider）对应的成本。有价格配置时非 null。
- 延迟：静态先验（tier 基准 + provider 偏移 + 模型覆盖），**无 `Math.random()`**，相同输入相同输出。
- 质量：仅在候选通过硬约束后计算，上限 0.95（不输出 1.0）。

## 7. Shadow 持久化（SQLite `shadow_decisions`）

流程：执行前 `saveShadowDecision`（upsert 建议）→ Finalize 后 `finalizeShadowDecision`（更新真实结果）。

| 字段 | 说明 |
| --- | --- |
| request_id | 唯一（三协议同一内部 sr_ id） |
| protocol / agent_id / requested_model | 请求上下文 |
| task_profile | **脱敏任务特征**（白名单，不含 lastUserText/完整 Prompt） |
| recommendation / ranked_candidates / predictions / explanation | 智能建议（JSON） |
| actual_final_model / actual_final_provider / actual_outcome | 最终真实结果（来自 Audit） |
| actual_attempt_count / actual_usage / actual_cost / actual_latency | 真实统计 |
| comparison_status | 对照状态 |
| created_at / finalized_at | 时间线（created_at <= finalized_at） |

- 保留天数：`intelligence.shadow.retentionDays`（默认 30），启动时清理过期记录。
- 重启后记录仍存在（SQLite 持久化，测试已验证）。

## 8. 对照状态机

| 状态 | 条件 |
| --- | --- |
| exact_match | 建议与真实 模型+Provider 均一致（completed） |
| model_match_provider_diff | 模型一致、Provider 不同 |
| policy_agreement | 建议=null 且真实=budget_exceeded/no_candidate（双方都拒绝） |
| different | 建议与实际不一致 |
| not_comparable | client_aborted / internal_error 等非模型选择终态 |

建议采纳率分母 = exact_match + model_match_provider_diff + different（**不含** not_comparable / policy_agreement）。

## 9. 模式语义

| 模式 | 执行路径 | Shadow 记录 | 开销 |
| --- | --- | --- | --- |
| `off` | Phase1 完全一致 | 无（不落库） | 零 |
| `shadow` | Phase1 完全一致 | 建议 + 最终结果 | 纯本地计算 + 同步 SQLite 写 |

## 10. 接入点

- `src/server.js`：`new IntelligenceLayer(config, store)` + `intelligence.attachTo(finalizer)` + 启动 `prune()`。
- 5 个协议处理器：候选构建后（无候选检查前）插入 3b suggest hook；删除提前 recordTraditional。
- `src/config/validator.js`：`intelligence.mode` 允许 `off | shadow`。
- 智能输出为机器可执行元数据（JSON），**不附加任何 System Prompt**，不修改消息内容。
