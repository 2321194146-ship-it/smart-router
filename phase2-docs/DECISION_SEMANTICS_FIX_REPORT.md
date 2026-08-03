# Decision Semantics 修复报告（Phase2-C 第 1-6 节）

## 背景
Phase2-B 独立验收后（基线 c5f182a，npm test 500/500，AR 105/105），发现评测集之外
仍存在 6 类决策语义问题。本报告记录每类的修复方案、代码位置与回归证据。

## 1. 分离二元能力与等级能力（第 1 节）
- 问题：旧逻辑 `requiredCapabilities >= 1.0 → 全部视为硬能力`，导致 chat=95/coding=95
  被误作 "missing chat/coding" 而 blocked。
- 修复：
  - `src/intelligence/task-analyzer.js`：新增 `HARD_CAPABILITY_KEYS`
    （streaming/vision/tool_use/structured_output）与 `SOFT_CAPABILITY_KEYS`
    （chat/coding/reasoning）；`hardCapabilities` 仅含二元硬能力。
  - `src/intelligence/capability-registry.js`：新增 `supports`（布尔视图）与
    `scores`（0-100 视图）导出；`BINARY_CAPABILITY_THRESHOLD=0.9`（vision=95 视为支持）。
  - `src/intelligence/policy.js`：`hardConstraintBlock` 只对二元能力做硬性判定；
    等级能力仅当显式配置 `gradedSafetyThreshold>0` 才阻断。
- 回归测试：chat=95 执行普通聊天；coding=95 执行代码任务；reasoning=80 参与推理；
  vision=95 不得误作"不支持视觉"；vision=60 仍阻断。
- 验证：test/unit/intelligence.test.js（C2 回归组）通过。

## 2. 工具可用 vs 工具必需（第 2 节）
- 问题：`body.tools` 存在即判 tool_orchestration，普通问题被强制要求工具能力。
- 修复：`analyzeTask` 输出 `toolsAvailable` 与 `toolsRequired`；
  `toolsRequired` 仅由 tool_choice 强制、协议字段要求或用户显式命令式表达
  （TOOL_REQUIRED_HINTS / TOOL_REQUIRED_PATTERNS）触发。
- 验证：Claude Code / Codex 风格测试（tools 存在 + 普通解释 → 不误判）。

## 3. 协议级结构化输出检测（第 3 节）
- 问题：仅靠 "JSON" 关键词判定结构化输出。
- 修复：`detectProtocolStructuredOutput` 识别 response_format.type=json_object/json_schema
  （OpenAI Chat）、text.format/json_schema（Responses）、output_config（Anthropic）；
  `structuredOutputRequired=true` → 硬性要求（1.0）。
- 验证：C3 协议级测试组通过。

## 4. 上下文 Token 估算（第 4 节）
- 问题：`allText.length / 3.5` 对 CJK 严重低估（1.3 万中文字符只估 ~3715）。
- 修复：新建 `src/intelligence/token-estimator.js`：CJK 1.5 token/字、非 CJK 3.5 字符/token、
  消息结构开销、图片预分配 800、tool schema/结构化 JSON、输出预留、1.1 安全余量；
  contextWindow 硬约束改用 input+output 总量（`estimatedTotalTokens`）。
- 验证：test/unit/token-estimator.test.js（CJK / 大 schema / 多轮 tool_result /
  input+output ≤ contextWindow / 近边界）通过。

## 5. 统一 Phase1/Phase2 能力数据源（第 5 节）
- 问题：Phase1 `candidates.js` 只读 legacy `capability` 数组 → capabilities-only 模型
  产生 0 候选。
- 修复：`candidates.js` 复用 `extractCapabilities` + `BINARY_CAPABILITY_THRESHOLD`；
  兼容 legacy 数组与新对象，阈值与 Phase2 一致（0.9）。
- 验证：C5 能力数据源统一测试组通过（caps-only / legacy-only / vision=95 / vision=60）。

## 6. Policy 配置真实生效（第 6 节）
- 问题：preferFree / tierPreference 切换不改变评分。
- 修复：
  - preferFree=true → 无强 soft 需求任务中免费候选成本分下限 0.6（"质量达标后优先免费"）；
    preferFree=false → 不惩罚付费（paidPenalty 不生效）。
  - tierPreference=false → tier 权重置 0。
  - 权重归一化（避免配置调整导致总分失衡）。
  - 确定性 Tie-Breaker：score → capability → reliability → cost → latency → Phase1 顺序
    （`pickBest`，无 tier）。
- 验证：test/unit/policy-toggle.test.js 通过。

## 验证总览
- npm test：562/562 通过（基线 500 + 62 新增）。
- Active Readiness 105 回归：classification 100%、hard_violations 0、gates PASS。
- Holdout 208 对抗任务：classification 100%、hard_violations 0、policy_execution 100%、
  acceptable 100%、gates PASS。
