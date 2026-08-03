# 协议级结构化输出检测报告（Phase2-C 第 3 节）

## 问题
结构化输出仅靠正文关键词（"JSON"等）判定，未识别协议级强制字段，导致：
- 协议要求结构化输出时未强制 structured_output 能力；
- 正文提及 "JSON format" 的名词短语被误判为结构化输出任务。

## 协议级检测（detectProtocolStructuredOutput）
- OpenAI Chat：`response_format.type = json_object | json_schema`（含 json_schema 对象）。
- OpenAI Responses：`text.format = json_object | json_schema | json`；`text.json_schema`。
- Anthropic：`output_config` 对象存在。
命中 → `structuredOutputRequired=true` → `requiredCapabilities.structured_output=1.0`（硬）。

## 修复
- `src/intelligence/task-analyzer.js`：新增检测函数；taskType 判定协议强制优先；
  仅关键词（非协议）时 structured_output=0.8（软参与）。
- 从 STRUCTURED_OUTPUT_HINTS 移除 'json format'（"Tell me about JSON format" 属介绍性提问）。

## 验证
- C3 协议级测试 8 项通过（response_format / text.format / output_config / json_schema /
  plain mention 不误判 / 硬约束阻断与放行）。
- Holdout protocol_* 与 json_mention_only 类别全通过。
