# 上下文 Token 估算修复报告（Phase2-C 第 4 节）

## 问题
`allText.length / 3.5` 对 CJK 严重低估（1.3 万中文字符只估 ~3715），且未计入
tool schema、图片、多轮 tool_result、输出预留等。

## 新估算器（src/intelligence/token-estimator.js）
确定性、保守（高估方向）、协议感知：
- CJK 字符：1.5 token/字（中文实际约 1.2-2）。
- 非 CJK：3.5 字符/token（英文标准 4，保守取 3.5）。
- 每条消息（含 role）附加 4 token；system/developer 单独计入。
- 图片内容块：预分配 800 token。
- tool_use / tool_result / function_call 内容块计入文本 + 结构开销。
- tool schemas：JSON 长度 /3 字符每 token + 每工具 8 token。
- response_format / text.json_schema / output_config：JSON 长度 + 固定开销。
- 输出预留：max_tokens / max_output_tokens / max_completion_tokens（默认 500）。
- 总量（input+output）×1.1 安全余量。

## 接入
- `task-analyzer.js`：estimatedInputTokens / estimatedOutputTokens / estimatedTotalTokens；
  hasLongContext 用 input。
- `policy.js`：contextWindow 硬约束优先用 `estimatedTotalTokens`（input+output）。

## 验证（test/unit/token-estimator.test.js，7 项）
- CJK 1.3 万字估算 >9000（远超旧 3715）。
- 确定性：同输入同输出。
- 多轮 tool_result 计入输入。
- 大 tool schema（12 工具 × 大参数）触发 long_context。
- input+output ≤ contextWindow；溢出 blocked。
- 近边界：输入小但输出预留大 → 总量超窗 → blocked。
- 图片块预分配计入。
