# SHADOW_RUN_REPORT.md

Smart Router Mainline - Phase 2-A Shadow 真实运行报告
运行方式：进程内启动（shadow 模式）→ 真实外部 Provider 请求 → 导出 Shadow 记录

## 1. 运行命令

```bash
node shadow-run.mjs
# 内部：createServer(pilot-config-shadow-run.json) + listen(随机端口, mode=shadow)
# 请求：真实 modelscope / gateway(7878) 端点
```

## 2. 运行结果

| 请求 | HTTP | 记录 |
| --- | --- | --- |
| chat（coding 任务） | 200 | 1 |
| anthropic（解释任务） | 200 | 1 |
| responses（摘要任务） | 200 | 1 |
| tool_use（calculator 两轮） | 200 | 1 |
| fallback（bad-key 401→gateway） | 200 | 1 |
| paid_blocked | 402 | 1 |
| **合计** | — | **6 条 Shadow 记录** |

## 3. Shadow 记录样例（真实数据）

| requestId | 协议 | 任务类型 | 智能建议 | 真实选择 | 一致性 |
| --- | --- | --- | --- | --- | --- |
| sr_...7f298 | chat | coding | deepseek-ai/DeepSeek-V4-Flash (0.7) | modelscope/deepseek-ai/DeepSeek-V4-Flash | ✅ |
| sr_...ac823 | anthropic | chat | gateway-auto | gateway/gateway-auto | ✅ |
| sr_...0f871 | responses | extraction | gateway-auto | gateway/gateway-auto | ✅ |

## 4. 对照摘要（真实数据）

```json
{
  "requests": 6,
  "shadowRecords": 6,
  "agree": 4,
  "differ": 2,
  "suggestionAcceptedRate": "66.7%"
}
```

- 4/6 智能建议与真实选择一致（chat/anthropic/responses/fallback）。
- 2 条不一致（tool_use 与 paid_blocked 场景：paid_blocked 无推荐，工具场景建议与真实 tier 选择有差异），
  差异原因记录在 Explainability 中（淘汰原因/预算阻止）。

## 5. 约束验证

- **不增加上游调用**：与 off 模式相同请求集对比，上游调用次数一致（shadow-mode 集成测试断言
  `countChatPosts === 1`）。
- **不修改候选顺序**：Decision Engine 只读候选，输出排序仅为元数据。
- **不影响用户响应**：off 与 shadow 响应内容一致（shadow-mode 集成测试断言）。
- **三协议同一 requestId**：6 条记录均为内部 `sr_` requestId，协议字段正确区分。
- **可切回 off**：`intelligence.mode: "off"` 配置即恢复（集成测试断言 0 记录）。

## 6. 原始数据

- `shadow-run-report.json`（完整记录与对照明细）
- `test/integration/shadow-mode.test.js`（自动化验证：4 项断言）
- `test/unit/intelligence.test.js`（25 项单元测试）
