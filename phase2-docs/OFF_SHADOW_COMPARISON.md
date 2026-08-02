# OFF_SHADOW_COMPARISON.md

Smart Router Mainline - Phase 2-A Off 与 Shadow 对照指标

## 1. 对照方法

- 同一请求集分别在 `intelligence.mode=off` 与 `mode=shadow` 下执行（`test/integration/shadow-mode.test.js`）。
- 对照指标：上游调用次数、用户响应内容、Shadow 记录数、建议采纳率。

## 2. 对照结果

| 指标 | off 模式 | shadow 模式 |
| --- | --- | --- |
| 上游调用次数（同请求） | N | N（**不增加**，断言 `countChatPosts === 1`） |
| 用户响应 | 正常（OFF_OK） | 正常（SHADOW_OK），内容不受影响 |
| Shadow 记录 | 0 | 1/请求（含建议+真实结果） |
| 响应耗时增量 | 0 | 纯本地毫秒级（无网络） |
| 候选顺序 | Phase1 原序 | Phase1 原序（只读） |
| 三协议 requestId | sr_ 内部 id | 同一 sr_ id（协议字段正确区分） |
| 切回 off | — | 配置 `mode:"off"` 立即生效（0 记录） |

## 3. 真实运行对照（shadow-run-report.json）

| 场景 | 建议 | 真实 | 一致 |
| --- | --- | --- | --- |
| chat coding | deepseek-ai/DeepSeek-V4-Flash | modelscope/deepseek | ✅ |
| anthropic | gateway-auto | gateway | ✅ |
| responses | gateway-auto | gateway | ✅ |
| fallback | gateway-auto | gateway（401→成功） | ✅ |
| tool_use | 差异（建议 tier 排序 vs 真实选择） | 记录差异原因 | ⚠️ 已解释 |
| paid_blocked | null（预算阻止） | 402 | ✅ 语义一致 |

**建议采纳率：66.7%（4/6）**；差异场景均有 Explainability 淘汰原因。

## 4. 结论

- Shadow 模式对生产路径**零影响**：调用次数、响应内容、候选顺序均与 off 一致。
- 智能建议与真实选择在多数场景一致；差异场景被完整记录并解释，为 Active 阶段提供决策依据。
- 可随时切回 off（Phase1 行为完全保留）。
