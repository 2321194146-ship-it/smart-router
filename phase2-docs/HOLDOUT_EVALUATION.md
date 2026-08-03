# Holdout 对抗评测报告（Phase2-C 第 7 节）

## 目的
在 Phase2-B 105 回归集之外，建立独立 Holdout 对抗评测，验证 Phase2-C 决策语义修复，
不复制原有关键字模板。

## 任务集（scripts/holdout-tasks.mjs，208 任务）
覆盖类别：
- 同义词：summarization / translation / extraction / writing / analysis / debugging /
  research（EN + ZH，共 98 项）
- 无关键词 / 含蓄意图：no_keyword_chat（16）、implicit_reasoning（5）
- 工具可用 vs 必需：tools_present_unneeded*、tool_required_explicit、tool_choice_*
- 协议级结构化：response_format / json_schema / text.format / output_config / json_mention_only
- 上下文 / Token：cjk_long_context（中文长文）、large_tool_schema、multi_turn_tool
- 等级能力分与模型形态：graded_chat95 / graded_coding95 / graded_vision95 /
  graded_reasoning80、caps_only_coding、legacy_only_vision
- Policy 切换：preferFree / noPreferFree / noTier
- 混合语言 / 歧义 / null 安全：mixed_lang*、ambiguous_*、null_safe_strict
- 健康 / 预算边界 / no-paid / strict / fallback

## 模型池（scripts/holdout-eval.mjs）
caps-only（无 legacy 数组）、legacy-only、60-99 等级能力分（coding=95/tool_use=90/
streaming=90/vision=95）、付费推理模型、大窗口模型、小窗口模型、健康失败模型。

## 指标
classification / outcome / acceptable_recommendation / soft_match / cost_reasonableness /
policy_execution / null_safe_rejection / hard_violations（streaming/vision/tool/context/
budget/no_paid/strict）/ confusion_matrix。

## 结果（evidence/holdout-eval-report.json/.md）
- classification：100%（208/208）
- outcome：100%
- acceptable_recommendation：100%
- soft_match：100%
- policy_execution：100%
- cost_reasonableness：100%
- null_safe_rejection：0
- hard_violations：0（全部子项 0）
- 门禁：全部 PASS

## 门禁（Phase2-C 第 7 节要求）
classification >= 92% ✅｜hard=0 ✅｜budget=0 ✅｜no-paid=0 ✅｜strict=0 ✅
policy_switch_execution=100% ✅｜acceptable >= 90% ✅｜contextWindow=0 ✅
低置信度允许 recommendation=null（null_safe 任务已验证安全拒绝）。

## 数据
- 脱敏任务清单：holdout-eval-data/tasks.json（id/category/expectedType）
- 完整报告：evidence/holdout-eval-report.json
