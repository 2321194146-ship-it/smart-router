# Active Canary 控制器设计（Phase2-C 第 8 节）

## 模式
- off：智能层禁用（Phase1 行为不变）。
- shadow：执行前生成建议（await + 异常隔离），不改变执行。
- active_canary：shadow 决策 + 低风险采样重排（默认关闭，需显式配置开启）。

配置示例（config/config.example.json）：
```json
"intelligence": {
  "mode": "active_canary",
  "activeCanary": {
    "percentage": 5,
    "allowedAgents": ["test-agent-1"],
    "allowedTaskTypes": ["general_chat", "writing", "summarization", "translation", "extraction"]
  }
}
```

## 确定性采样
requestId 的 SHA-256 哈希（node:crypto），取前 8 位 hex → [0,100)；
`(hash % 100) < percentage` 即命中。无 Math.random，可复现。

## 重排规则
- 仅允许在【Phase1-legal 候选】内重排：候选必须未被能力/预算/协议硬约束 blocked。
- Primary = 智能建议推荐模型（decision.recommendation，Phase1-legal）。
- 重排后：Primary 置顶，其余保持 Phase1 原始顺序（稳定排序）。
- 协议层（5 个协议 3b 钩子）应用 `decision.canary.orderedCandidates` 执行。

## 禁止项（严格不实现）
- 扩展候选集合（不新增候选）。
- 绕过 budget / allowedModels / allowedProviders（重排前防御性校验）。
- 改变 strict 语义（strict 阶段不参与重排）。
- 修改用户消息 / 注入 System Prompt（canary 不触碰 body）。
- 首字节后切换模型（重排在执行前一次性定序）。
- 并行模型调用（仅串行 Fallback 顺序变化）。

## Fail Open
apply() 内任何异常 / 非法状态 → 返回 Phase1 原始候选顺序（active=false），
用户请求不受影响。

## Kill Switch
`IntelligenceLayer.killCanary(reason)` 或配置 `activeCanary.killSwitch:true`：
立即停止采样（无需改代码），后续请求全部走 Phase1 顺序。

## 实现
- src/intelligence/canary-controller.js（CanaryController）
- src/intelligence/index.js（IntelligenceLayer 集成：suggest 应用 / recordFinalized 记录）
- src/config/validator.js（允许 active_canary 模式）
- src/protocols/*.js（3b 钩子应用 orderedCandidates）

## 验证
- test/unit/canary-controller.test.js（15 项）
- test/integration/canary-active.test.js（2 项端到端：active_canary 重排生效、
  shadow 不重排）
