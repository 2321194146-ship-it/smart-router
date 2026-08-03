# 5% Canary Live Pilot 报告（Phase2-C）

## 目标
在独立端口 `127.0.0.1:28788` 开启指定 Claude Code 的 5% 低风险 Active Canary（内部实验），积累 **20 个实际 Active 请求**（active=true 的真实请求，非总请求数），并验证 Kill Switch / 自动停止 / 重启持久化。

## 允许流式 Claude Code 请求参与 Canary
- `needsStreaming=true` 不再直接排除；流式请求可进入第一批 Canary，但必须同时满足：
  - `protocol=anthropic`（第一批严格限制 Anthropic）
  - `agentId=claude-code`（allowedAgents）
  - Task Type 属于允许的低风险类型
  - 所有 Canary 执行候选均明确支持 streaming（Canary 层最终防线 `excluded:streaming_candidate_unsupported`）
  - toolsRequired / visionRequired / structuredOutputRequired / needsLongContext / strictModel 均 false
  - 非 coding / debugging / architecture / research / analysis
  - Budget 合法、recommendation 存在、所有执行候选未 blocked
- 流式硬能力保留：`stream=true` + 模型不支持 streaming → 候选 blocked（DecisionEngine），不得进入 Fallback。

## 自动停止立即持久化
- `apply` 阶段停止（budget_violation 等）→ `IntelligenceLayer.suggest()` 返回前 `await persistCanaryState()`
- `Finalize` 阶段停止（budget_exceeded / first_byte_switch / repeated_tool / incomplete_rise / consecutive_provider_errors / consecutive_no_candidate）→ `recordFinalized()` 返回前 `await persistCanaryState()`
- 持久化失败：进程内 killed 状态仍立即生效（立即停止采样）；输出明确错误日志（`[canary] persistCanaryState failed`）；不影响用户原始请求。
- 重启测试（集成）：连续 3 个 Active incomplete / 3 个 provider_error / 1 次 first_byte_switch / apply budget_violation → SQLite `app_state.canary.killed` 写入 → 重启同库 → Canary 仍 stopped，`reason=killed` 不恢复 5% 采样。

## 首批配置（严格 Anthropic）
```json
{
  "intelligence": {
    "mode": "active_canary",
    "activeCanary": {
      "percentage": 5,
      "allowedAgents": ["claude-code"],
      "allowedProtocols": ["anthropic"],
      "allowedTaskTypes": ["general_chat", "writing", "summarization", "translation", "extraction"]
    }
  }
}
```
Responses / Chat 本轮禁止进入真实 Active Canary（Responses text.format 转换问题进入维护清单，不阻塞本轮）。

## Live Pilot 运行结果（127.0.0.1:28788）
- 运行方式：`node scripts/canary-live-pilot.mjs`（本地 Mock Anthropic 流式 Provider，真实 HTTP + SSE + SQLite 全链路；模拟 Claude Code 客户端 `User-Agent: Claude-Code/1.0` + `POST /v1/messages` + `stream=true`）
- 流量：发送 456 个低风险 Anthropic 流式请求，**active=20**（5% 确定性 SHA-256 采样）

| 指标 | 值 |
| --- | --- |
| eligible | 456 |
| sampled | 20 |
| active | 20（≥ 20 目标达成） |
| activeVsPhase1 | same=0, diff=20 |
| actuallyReordered | 20（全部 Active 请求均重排到 Canary Primary） |
| Phase1 Primary | phase1-first@mock |
| Canary Primary | canary-best@mock |
| 最终模型分布 | canary-best@mock: 20（Active）+ phase1-first@mock: 436（Phase1） |
| outcome 分布 | completed: 456 |
| Attempts | 20（仅 Active 计入） |
| Fallback | 0 |
| 预计成本 | 0（Mock 无价格配置；真实环境由价格表驱动） |
| 实际成本 | 0（Mock 免费） |
| 自动停止 | 未触发（autoStop=null；正常低风险流量） |

## Kill Switch 验证
| 步骤 | 结果 |
| --- | --- |
| POST /_smart-router/intelligence/kill | 200, killed=true, stopped=true |
| 重启（同一 data_dir） | 200, stopped=true, autoStop=admin_kill_switch, restored=true |
| POST /_smart-router/intelligence/resume-shadow | 200, mode=shadow, canaryEnabled=false |

重启后 Kill Switch 保持持久化停止；resume-shadow 只恢复 Shadow，不自动恢复 Active。

## 自动停止验证
集成测试覆盖（test/integration/canary-auto-stop-persist.test.js，4 项）：
- incomplete_rise：3 个 Active incomplete → 停止 → 持久化 → 重启 stopped
- consecutive_provider_errors：3 个 Active provider_error → 停止 → 持久化 → 重启 stopped
- first_byte_switch：1 次首字节后切换 → 停止 → 持久化 → 重启 stopped
- budget_violation（apply 防御）：触发停止 → suggest 返回前持久化 → 重启 stopped

## 红线保障
预算越权 1 次 / strict 改变 1 次 / blocked 模型进执行链 1 次 / Prompt 注入 1 次 / 用户消息改写 1 次 /
首字节后切换 1 次 / 重复 Tool 1 次 / 连续 3 Provider 错误 / 连续 3 incomplete / 管理员 Kill
→ 立即自动 Kill 并持久化；不得重启自动恢复；必须管理员 resume-shadow 才能回 Shadow，绝不自动恢复 Active。

## 保护规则
- 不修改 7878 / 17878
- 不使用生产全部 Key（Mock / 低额度测试链路）
- 不对外开放（127.0.0.1 only）
- Admin Token 只放环境变量（SMART_ROUTER_ADMIN_TOKEN），不入 Git / 配置
- Kill 接口仅允许 127.0.0.1
- 不开启 Cloud 收费（Cloud Billing Blocker 保持标记，网站公开收费前必须单独解决）

## 证据文件
- evidence/canary-live-pilot-evidence.json（完整指标 + Kill Switch 验证）
- evidence/canary-live-pilot-config.sanitized.json（28788 实际启动配置脱敏版）
