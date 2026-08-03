# Holdout 对抗评测报告（Phase2-C，≥200 任务）

- 任务数：208 ｜ 分类准确率：100% ｜ 终态一致率：100%
- 可接受推荐率：100%（199/199，null 允许 0）
- Soft-Match：100%（199/199）
- 成本合理性：100%（4/4）
- Policy 切换执行率：100%（15/15）
- null 安全拒绝违规：0
- 硬能力违规：0（streaming=0 vision=0 tool=0 context=0 budget=0 no_paid=0 strict=0）
- 门禁：PASS（13/13 项通过）
- 运行时：确定性本地 Mock Provider（可复现、离线、零成本）；未开启 Active

## 门禁明细

| 指标 | 要求 | 实际 | 结果 |
| --- | --- | --- | --- |
| 分类准确率 >= 92% | - | 100% | ✅ |
| 硬能力违规 = 0 | - | 0 | ✅ |
| Streaming 违规 = 0 | - | 0 | ✅ |
| Vision 违规 = 0 | - | 0 | ✅ |
| Tool 违规 = 0 | - | 0 | ✅ |
| ContextWindow 违规 = 0 | - | 0 | ✅ |
| 预算越权 = 0 | - | 0 | ✅ |
| 禁付费越权 = 0 | - | 0 | ✅ |
| strict 改变 = 0 | - | 0 | ✅ |
| Policy 切换执行 = 100% | - | 100% | ✅ |
| 可接受集合推荐 >= 90% | - | 100% | ✅ |
| null 安全拒绝违规 = 0 | - | 0 | ✅ |
| 成本合理性 = 100% | - | 100% | ✅ |

## 分类错误

无分类错误。

## 明细（前 40 行）

| id | category | 期望类型 | 实际类型 | 建议 | 硬约束淘汰 | 真实结果 |
| --- | --- | --- | --- | --- | --- | --- |
| h001 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 567 > contextWindow 500 | completed |
| h002 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 565 > contextWindow 500 | completed |
| h003 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 570 > contextWindow 500 | completed |
| h004 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 566 > contextWindow 500 | completed |
| h005 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 569 > contextWindow 500 | completed |
| h006 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 564 > contextWindow 500 | completed |
| h007 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 565 > contextWindow 500 | completed |
| h008 | syn_summarization | summarization | summarization | mock/H-bigctx | input tokens 565 > contextWindow 500 | completed |
| h009 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 571 > contextWindow 500 | completed |
| h010 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 574 > contextWindow 500 | completed |
| h011 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 574 > contextWindow 500 | completed |
| h012 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 575 > contextWindow 500 | completed |
| h013 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 570 > contextWindow 500 | completed |
| h014 | syn_summarization_zh | summarization | summarization | mock/H-bigctx | input tokens 571 > contextWindow 500 | completed |
| h015 | syn_translation | translation | translation | mock/H-bigctx | input tokens 567 > contextWindow 500 | completed |
| h016 | syn_translation | translation | translation | mock/H-bigctx | input tokens 564 > contextWindow 500 | completed |
| h017 | syn_translation | translation | translation | mock/H-bigctx | input tokens 568 > contextWindow 500 | completed |
| h018 | syn_translation | translation | translation | mock/H-bigctx | input tokens 564 > contextWindow 500 | completed |
| h019 | syn_translation | translation | translation | mock/H-bigctx | input tokens 563 > contextWindow 500 | completed |
| h020 | syn_translation_zh | translation | translation | mock/H-bigctx | input tokens 568 > contextWindow 500 | completed |
| h021 | syn_translation_zh | translation | translation | mock/H-bigctx | input tokens 571 > contextWindow 500 | completed |
| h022 | syn_translation_zh | translation | translation | mock/H-bigctx | input tokens 571 > contextWindow 500 | completed |
| h023 | syn_translation_zh | translation | translation | mock/H-bigctx | input tokens 570 > contextWindow 500 | completed |
| h024 | syn_translation_zh | translation | translation | mock/H-bigctx | input tokens 574 > contextWindow 500 | completed |
| h025 | syn_extraction | extraction | extraction | mock/H-coding95 | input tokens 567 > contextWindow 500 | completed |
| h026 | syn_extraction | extraction | extraction | mock/H-coding95 | input tokens 568 > contextWindow 500 | completed |
| h027 | syn_extraction | extraction | extraction | mock/H-coding95 | input tokens 569 > contextWindow 500 | completed |
| h028 | syn_extraction | extraction | extraction | mock/H-coding95 | input tokens 567 > contextWindow 500 | completed |
| h029 | syn_extraction | extraction | extraction | mock/H-coding95 | input tokens 568 > contextWindow 500 | completed |
| h030 | syn_extraction_zh | extraction | extraction | mock/H-coding95 | input tokens 570 > contextWindow 500 | completed |
| h031 | syn_extraction_zh | extraction | extraction | mock/H-coding95 | input tokens 575 > contextWindow 500 | completed |
| h032 | syn_extraction_zh | extraction | extraction | mock/H-coding95 | input tokens 571 > contextWindow 500 | completed |
| h033 | syn_extraction_zh | extraction | extraction | mock/H-coding95 | input tokens 577 > contextWindow 500 | completed |
| h034 | syn_extraction_zh | extraction | extraction | mock/H-coding95 | input tokens 571 > contextWindow 500 | completed |
| h035 | syn_writing | writing | writing | mock/H-bigctx | input tokens 568 > contextWindow 500 | completed |
| h036 | syn_writing | writing | writing | mock/H-bigctx | input tokens 568 > contextWindow 500 | completed |
| h037 | syn_writing | writing | writing | mock/H-bigctx | input tokens 567 > contextWindow 500 | completed |
| h038 | syn_writing | writing | writing | mock/H-bigctx | input tokens 567 > contextWindow 500 | completed |
| h039 | syn_writing | writing | writing | mock/H-bigctx | input tokens 566 > contextWindow 500 | completed |
| h040 | syn_writing_zh | writing | writing | mock/H-bigctx | input tokens 574 > contextWindow 500 | completed |