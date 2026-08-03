# Active Readiness 评测报告（100+ 任务矩阵）

- 任务数：105 ｜ 分类准确率：100% ｜ 终态一致率：100%
- 可接受推荐率：100%（86/86，null 允许 1）
- 硬能力违规：0（streaming=0 vision=0 tool=0 context=0 budget=0 no_paid=0 strict=0）
- 对照：exact_match=9 policy_agreement=13 different=86 not_comparable=3 acceptance=9.5%
- 门禁：PASS（12/12 项通过）
- 运行时：确定性本地 Mock Provider（可复现、离线、零成本）；外部真实 Pilot 见 evidence/pilot-*.json
- 未开启 Active：本评测仅为 Active Readiness 指标

## 门禁明细

| 指标 | 要求 | 实际 | 结果 |
| --- | --- | --- | --- |
| 分类准确率 >= 95% | 0 | 100% | ✅ |
| 硬能力违规 = 0 | 0 | 0 | ✅ |
| Streaming 违规 = 0 | 0 | 0 | ✅ |
| Vision 违规 = 0 | 0 | 0 | ✅ |
| Tool 违规 = 0 | 0 | 0 | ✅ |
| ContextWindow 违规 = 0 | 0 | 0 | ✅ |
| 预算越权 = 0 | 0 | 0 | ✅ |
| 禁付费越权 = 0 | 0 | 0 | ✅ |
| strict 改变 = 0 | 0 | 0 | ✅ |
| 可接受集合推荐 >= 90% | 0 | 100% | ✅ |
| Prompt 注入 = 0 | 0 | 0 | ✅ |
| 用户消息改写 = 0 | 0 | 0 | ✅ |

## 分类错误与已知限制

无分类错误。

## 明细（前 30 行）

| id | category | 期望类型 | 实际类型 | 建议 | 硬约束淘汰 | 真实结果 | 比较状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t001 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t002 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t003 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t004 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t005 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t006 | simple_chat | general_chat | general_chat | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t007 | writing | writing | writing | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t008 | writing | writing | writing | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t009 | writing | writing | writing | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t010 | writing | writing | writing | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t011 | writing | writing | writing | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t012 | summarization | summarization | summarization | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t013 | summarization | summarization | summarization | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t014 | summarization | summarization | summarization | mock/M-nostream | - | completed (mock/M-chat-t1) | different |
| t015 | summarization | summarization | summarization | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t016 | summarization | summarization | summarization | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t017 | translation | translation | translation | mock/M-chat-t1 | - | completed (mock/M-chat-t1) | exact_match |
| t018 | translation | translation | translation | mock/M-chat-t1 | - | completed (mock/M-chat-t1) | exact_match |
| t019 | translation | translation | translation | mock/M-chat-t1 | - | completed (mock/M-chat-t1) | exact_match |
| t020 | translation | translation | translation | mock/M-chat-t1 | - | completed (mock/M-chat-t1) | exact_match |
| t021 | translation | translation | translation | mock/M-chat-t1 | - | completed (mock/M-chat-t1) | exact_match |
| t022 | extraction | extraction | extraction | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t023 | extraction | extraction | extraction | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t024 | extraction | extraction | extraction | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t025 | extraction | extraction | extraction | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t026 | extraction | extraction | extraction | mock/M-coding | - | completed (mock/M-chat-t1) | different |
| t027 | analysis | analysis | analysis | mock/M-reason | - | completed (mock/M-chat-t1) | different |
| t028 | analysis | analysis | analysis | mock/M-reason | - | completed (mock/M-chat-t1) | different |
| t029 | analysis | analysis | analysis | mock/M-reason | - | completed (mock/M-chat-t1) | different |
| t030 | analysis | analysis | analysis | mock/M-reason | - | completed (mock/M-chat-t1) | different |