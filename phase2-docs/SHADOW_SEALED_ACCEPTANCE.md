# SHADOW_SEALED_ACCEPTANCE.md

Smart Router Mainline - Phase 2-A Shadow 最终收口验收报告
提交：`fa12723` + Sealed 修复 ｜ 版本：`1.0.0-phase2-shadow`

## 1. 四大真实性问题的修复

### 问题一：拆分“建议生成”与“真实结果记录”

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| suggest() 时机 | execute() 之后（与 recordTraditional 同处） | **execute() 之前**（候选构建后、无候选检查前） |
| recordTraditional | 协议层 execute() 返回即写 | **删除**（5 个协议文件 0 处残留） |
| 真实结果来源 | ExecutionResult 临时状态 | **Finalizer 观察者收到最终 Audit** |
| 触发时机 | 立即 | **finalizeRequestAtomic 事务成功提交后** |
| 终态覆盖 | 部分 | completed / incomplete / client_aborted / budget_exceeded / no_candidate / provider_error(internal_error) 全覆盖 |

实现：`Finalizer.addObserver(fn)` + `_emitFinalized(auditRecord)`（事务提交后触发，异常隔离）；
`IntelligenceLayer.recordFinalized(auditRecord)` 从 Audit 提取真实模型/Provider/outcome/usage/cost/latency。
回归测试：Anthropic 流式 EOF → `actualOutcome=incomplete`（与 SQLite Audit 一致，**不得记 completed**）✅

### 问题二：Shadow 记录持久化

新增 SQLite 表 `shadow_decisions`（requestId 主键唯一），字段覆盖需求清单全部 19 项。
流程：执行前 `saveShadowDecision`（upsert 建议）→ Finalize 后 `finalizeShadowDecision`（更新真实结果）。

- 脱敏：`task_profile` 仅白名单特征（taskType/complexity/token 估算/能力信号），**不含 lastUserText/完整 Prompt**（测试断言 `!('lastUserText' in taskProfile)`）。
- 保留天数：`intelligence.shadow.retentionDays`（默认 30），启动 prune。
- 重启持久：重启后记录仍在（测试 5 ✅）。
- 三协议同一 requestId：chat/responses/anthropic 均验证（✅）。

### 问题三：Capability Registry 真正进入 Decision Engine

- 统一候选身份 `modelId + provider`：`registry.getProfile(modelId, provider)` 返回标准化画像
  `{ modelId, provider, tier, paid, capabilities, contextWindow, price, protocols }`。
- 同 modelId 不同 Provider 分开评分、分开预测（单测 ✅：pA 免费有 vision vs pB 付费无 vision，推荐 pA，成本分别计算）。
- 处理能力：tool_use / vision / streaming / contextWindow / Chat / Responses / Anthropic（protocols 派生）。

### 问题四：必要能力改为硬约束

`policy.hardConstraintBlock`：tool_use / vision / contextWindow / protocol 缺失 → `score=0 + blocked`，绝不推荐。
单测：仅非 tool_use 候选 → `recommendation=null` ✅；便宜无 vision + 付费有 vision → 视觉任务只推荐有 vision 的合法模型 ✅；
contextWindow 超限 → blocked ✅。评测：tool/vision/longctx 任务硬约束淘汰全部正确 ✅。

## 2. 成本/质量/延迟预测修正

| 项 | 修复 |
| --- | --- |
| 成本 | 每候选按自己 price 计算；`predictions.cost` = 推荐候选（modelId+provider）对应成本；有价格配置非 null（评测 vision 任务 cost=0.00536 ✅） |
| 延迟 | 删除 `Math.random()`；确定性静态先验（tier 基准 + provider 偏移 + 模型覆盖）；相同输入相同输出（单测 ✅） |
| 质量 | 仅在通过硬约束后计算；上限 0.95（不输出 1.0）（单测 ✅） |

## 3. 对照统计修正

新增 5 态：`exact_match` / `model_match_provider_diff` / `policy_agreement` / `different` / `not_comparable`。
- 建议=null + 真实=budget_exceeded → **policy_agreement**（不再是“不一致”）✅
- 采纳率分母不含 not_comparable 与 policy_agreement ✅
- 评测对照：exact_match=19，policy_agreement=6，different=6，not_comparable=2，acceptance=76%（数据自洽，差异均有解释）

## 4. 回归测试

| 类别 | 覆盖 | 结果 |
| --- | --- | --- |
| Anthropic 流式 EOF | actualOutcome=incomplete，与 Audit 一致 | ✅ |
| Chat/Responses/Anthropic 客户端取消 | actualOutcome=client_aborted，not_comparable | ✅ |
| no_candidate / budget_exceeded | 均有 Shadow 记录，policy_agreement + 拒绝原因 | ✅ |
| 缺少 tool_use / vision | 候选 blocked，不推荐 | ✅ |
| 同 modelId 不同 Provider | 能力/价格/推荐按 Provider 区分 | ✅ |
| 成本预测 | 有价格配置非 null，等于推荐候选成本 | ✅ |
| 持久化重启 | 记录仍在，建议与最终均完整 | ✅ |
| off 模式 | 无 Shadow 记录，Phase1 行为不变 | ✅ |

## 5. 发布一致性

- package.json / package-lock.json / RELEASE_MANIFEST.json / README 版本统一 `1.0.0-phase2-shadow`。
- Manifest 不含自身 Hash。
- 可复跑评测脚本：`scripts/shadow-eval.mjs`（33 固定脱敏任务，确定性 mock）。
- 脱敏配置模板：`config/shadow-eval-config.template.json`。

## 6. 端点诚实声明

- **ModelScope 为直连真实 Provider**（真实外部 Pilot 9/9 通过，evidence/pilot-*.json）。
- **Anthropic / Responses 当前经 7878 转发**（真实网关链路，非 28788 直接连接官方外部 Provider）。
- Tool 场景与 Fallback 场景的实际一致性均与 JSON 证据一致（评测 + 真实 Pilot 双证据）。

## 7. 最终门禁

`npm test` ｜ `npm run test:unit` ｜ `npm run test:integration` ｜ `npm run test:audit` ｜ `npm run syntax:check` 全部退出 0。
