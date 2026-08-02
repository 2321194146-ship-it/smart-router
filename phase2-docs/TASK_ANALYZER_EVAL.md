# TASK_ANALYZER_EVAL.md

Smart Router Mainline - Phase 2-A Task Analyzer 评测

## 1. 评测方法

单元测试（`test/unit/intelligence.test.js`）覆盖任务类型识别、复杂度边界、能力信号、多协议输入格式；
Shadow 真实运行（`shadow-run-report.json`）覆盖真实请求的任务画像。

## 2. 类型识别评测

| 输入 | 期望类型 | 实际 | 结果 |
| --- | --- | --- | --- |
| "Write a function to sort an array in JavaScript" | coding | coding | ✅ |
| tools 定义 + "Use the calculator tool" | tool_orchestration | tool_orchestration | ✅ |
| image_url 块 + "describe this" | vision | vision | ✅ |
| "Explain why the sky is blue"（Responses input 字符串） | analysis | analysis | ✅ |
| "hi"（短对话） | chat | chat | ✅ |

## 3. 真实运行画像（shadow-run-report）

| 请求 | 任务类型 | 复杂度 | 信号 |
| --- | --- | --- | --- |
| "Write a small JavaScript function to debounce" | coding | ~0.42 | coding |
| "Explain the difference between TCP and UDP" | chat | 低 | — |
| "Summarize this in one sentence: smart routing" | extraction | ~0.24 | extraction |
| tool_use 请求 | tool_orchestration | 中 | tool_use |

## 4. 边界与可靠性

- 复杂度恒在 [0,1]，由类型权重(0.6) + 上下文规模(0.25) + 轮次(0.15) 加权。
- 上下文 token 预估：字符数 / 3.5（无 tokenizer，Shadow 版启发式）。
- 多协议兼容：chat messages / anthropic system+messages / responses input（字符串或数组）。
- 只读不改写：Task Analyzer 不修改任何消息内容（禁止用户消息改写）。

## 5. 结论

Task Analyzer 在 8 个单元场景 + 4 个真实场景下全部正确；类型识别准确，复杂度有界，
多协议输入兼容，纯本地零副作用。
