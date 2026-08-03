# Tool Available vs Required 报告（Phase2-C 第 2 节）

## 问题
请求体携带 `tools` 数组（仅表示"可用"）时，旧逻辑直接判定 tool_orchestration 并
要求 tool_use 硬能力，导致普通问题（"Please explain how web search works" + tools）
被错误限制在工具模型上。

## 语义定义
- `toolsAvailable`：`body.tools` 存在且非空（仅表明可用，不影响分类/淘汰/成本）。
- `toolsRequired`：工具调用是任务必需，触发条件（高置信度）：
  1. 协议级 `tool_choice` 强制：'required'/'any'/具体函数对象（'auto'/'none' 不算）。
  2. 用户显式命令式表达：TOOL_REQUIRED_HINTS（'use the tool', 'call a tool',
     '调用函数', '使用工具', '调用工具' 等）或 TOOL_REQUIRED_PATTERNS
     （/call|use|invoke|run|trigger ... tool/、/(调用|使用)[中文]{0,6}工具/）。

## 实现
- `src/intelligence/task-analyzer.js`：`isToolChoiceRequired` + 显式信号判定；
  `needsToolUse` 仅由 `toolsRequired` 驱动；`signals` 输出 tools_available/tool_use。
- `policy.js`：tool_use 硬约束仅当 `needsToolUse=true`（即 toolsRequired）触发。

## 回归测试（Claude Code / Codex 风格）
- tools 存在 + 普通解释 → general_chat / analysis，toolsRequired=false，非工具候选不被 block。
- tools 存在 + "Use the calculator tool..." → tool_orchestration，工具候选必须。
- tool_choice='required' / {type:'function',name:...} → toolsRequired=true。
- tool_choice='auto'/'none' → toolsRequired=false。
- "What is a calculator?"（无命令式）→ 不触发工具必需。

## 验证
test/unit/intelligence.test.js（C2 工具可用 vs 必需组）10 项通过；
Holdout 评测 tools_present_unneeded / tool_required_explicit / tool_choice_* 类别全通过。
