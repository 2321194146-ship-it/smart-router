# Shadow 评测报告（30+ 任务矩阵）

- 模式：shadow ｜ 运行时：确定性本地 Mock Provider（可复现、离线、零成本）
- 任务数：33 ｜ Shadow 记录：33
- 分类准确率：97%（32/33）
- 终态一致率：100%（33/33）
- 对照：exact_match=19，model_match_provider_diff=0，policy_agreement=6，different=6，not_comparable=2，acceptance=76%

## 分类错误与已知限制

- `summ-02`（summarization）：期望 extraction，实际 chat

已知限制：summ-02 "Give me a brief summary" 未命中 extract 关键词（summarize/summary 变体缺失），归为 chat。其余任务分类与终态全部正确。

## 明细

| taskId | category | taskType | 建议 | 硬约束淘汰 | 预计成本 | 真实结果 | 比较状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chat-01 | chat | chat | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| chat-02 | chat | chat | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| chat-03 | chat | chat | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| coding-01 | coding | coding | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| coding-02 | coding | coding | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| coding-03 | coding | coding | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| analysis-01 | analysis | analysis | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| analysis-02 | analysis | analysis | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| summ-01 | summarization | extraction | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| summ-02 | summarization | chat | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| trans-01 | translation | extraction | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| trans-02 | translation | extraction | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| extract-01 | extraction | extraction | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| extract-02 | extraction | extraction | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| tool-01 | tool_use | tool_orchestration | mock/eval-tool | missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required) | 0 | completed (mock/eval-chat) | different |
| tool-02 | tool_use | tool_orchestration | mock/eval-tool | missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required) | 0 | completed (mock/eval-chat) | different |
| tool-03 | tool_use | tool_orchestration | mock/eval-tool | missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required); missing tool_use (required) | 0 | completed (mock/eval-chat) | different |
| vision-01 | vision | vision | mock/eval-vision | - | 0.00536 | completed (mock/eval-vision) | exact_match |
| vision-02 | vision | vision | mock/eval-vision | - | 0.005365 | completed (mock/eval-vision) | exact_match |
| longctx-01 | long_context | analysis | mock/eval-chat | input tokens 4300 > contextWindow 500 | 0 | completed (mock/eval-chat) | exact_match |
| longctx-02 | long_context | analysis | mock/eval-chat | input tokens 3578 > contextWindow 500 | 0 | completed (mock/eval-chat) | exact_match |
| strict-01 | strict | chat | - | - | - | no_candidate | policy_agreement |
| strict-02 | strict | chat | - | - | - | no_candidate | policy_agreement |
| nopaid-01 | no_paid | chat | - | paid model blocked by allowPaid=false | - | budget_exceeded | policy_agreement |
| nopaid-02 | no_paid | chat | - | paid model blocked by allowPaid=false | - | budget_exceeded | policy_agreement |
| nc-01 | no_candidate | chat | - | - | - | no_candidate | policy_agreement |
| nc-02 | no_candidate | chat | - | - | - | no_candidate | policy_agreement |
| fallback-01 | fallback | chat | mock-fail/eval-fail | - | 0 | completed (mock/eval-chat) | different |
| fallback-02 | fallback | chat | mock/eval-chat | - | 0 | completed (mock/eval-chat) | exact_match |
| abort-01 | client_aborted | chat | mock/eval-chat | - | 0 | client_aborted (mock/eval-chat) | not_comparable |
| abort-02 | client_aborted | chat | mock/eval-tool | - | 0 | client_aborted (mock/eval-tool) | not_comparable |
| eof-01 | incomplete | chat | mock/eval-eof | - | 0 | incomplete (mock/eval-eof) | different |
| eof-02 | incomplete | chat | mock/eval-eof | - | 0 | incomplete (mock/eval-eof) | different |