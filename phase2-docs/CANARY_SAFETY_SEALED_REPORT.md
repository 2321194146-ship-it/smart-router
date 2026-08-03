# Canary 安全收口报告（Phase2-C Safety Sealed）

## 范围
独立验收确认 562/562 测试、208 条 Holdout 评测可复跑、决策语义修复完成后，本轮仅做 Canary 控制器 8 项安全收口。Phase1 与 Shadow 未重建；未新增评测体系 / Task 分类 / 网站 / Dashboard。

## 8 项收口

### 一、Fallback 链只保留 Decision 合法候选
- `CanaryController.apply()` 以 `decision.ranked` 中 `blocked==null` 的候选为唯一合法集合（`legalIds`）。
- `orderedCandidates` 只从合法集合内构建：Primary 置顶，其余合法候选保持 Phase1 原始顺序（稳定排序）。
- **blocked 候选绝不进入 Canary Fallback 链**（场景 A→B→C：B 被硬能力 blocked 时绝不会出现在执行链）。
- 全部候选 blocked → `excluded:no_legal_candidate`；Primary 不在合法集合 → `primary_not_legal`（Fail Safe）。

### 二、Canary 指标只统计实际 Active 请求
- 新增 `activeRequests: Map<requestId, metadata>`：仅在采样命中（`active=true`）时登记。
- `recordFinalized()` 只处理 `activeRequests` 中存在的 requestId；普通 Phase1（未采样）请求直接忽略，不进入指标、不计入连续错误、不触发自动停止。
- Finalize 后删除该条目（防内存增长）；`snapshot().activeRequests` 暴露当前在飞 Active 数。

### 三、补齐预算防御与低风险资格判断
- 预算防御：`allowPaid / allowedModels / allowedProviders / maxRequestCost / strictModel`，使用 `decision.ranked` 完整条目（含 `paid` / `estimatedCost`）。
- 完整 `decision.task` 由 `IntelligenceLayer.suggest()` 透传给 `CanaryController`（低风险资格全量判断）。
- 第一批 5% 排除条件：`toolsRequired` / `needsVision` / `structuredOutputRequired` / `needsLongContext` / `needsStreaming` / `strictModel`（预算） / 高风险任务类型（vision/tool_orchestration/structured_output/debugging/architecture/coding/research/analysis） / `complexity>=0.6` / 低置信度（无 recommendation） / 非允许协议 / 硬能力全 blocked。

### 四、真正可操作的 Kill Switch（方案A：本地管理接口）
- `GET  /_smart-router/intelligence/status`：状态与指标。
- `POST /_smart-router/intelligence/kill`：立即停止采样 + 持久化（SQLite `app_state.canary.killed`），重启后仍保持。
- `POST /_smart-router/intelligence/resume-shadow`：只恢复 Shadow（`intelligence.mode=shadow` 持久化），**绝不自动恢复 Active**。
- 安全约束：仅回环地址（127.0.0.1 / ::1）+ `Authorization: Bearer <token>`；token 来自环境变量 `SMART_ROUTER_ADMIN_TOKEN`（不入 Git）或配置 `intelligence.adminToken`；未配置 token 时管理接口 503。

### 五、修正首批 Canary 配置
- `config/config.example.json`：`allowedAgents: ["claude-code"]`（删除 `test-agent-1`）。

### 六、修正指标语义
- 连续错误为**真连续**计数（`provider_error / no_candidate / incomplete`），成功或无关 outcome 立即清零。
- 自动停止条件仅基于 Active 请求：预算违规 1 次（apply/执行）、首字节后切换 1 次、重复 Tool 1 次、连续 Provider 错误 3 次、连续 incomplete 达阈值、管理员 Kill Switch。

### 七、发布一致性
- `package.json` / `package-lock.json` / `README.md` / `RELEASE_MANIFEST.json` 统一 `1.0.0-phase2c-active-canary`。
- Git 证据三处统一：README 最终提交、`evidence/git-commit-sha.txt`、`RELEASE_MANIFEST.json` 的 `commit` 字段。

### 八、固定测试 + 10 项证明
- 单元测试重写并扩充：`test/unit/canary-controller.test.js`（42 项，含合法候选过滤 / Active 指标 / 低风险资格 / 预算防御 / 真连续错误 / restoreKilled / 持久化恢复）。
- 新增管理接口集成测试：`test/integration/canary-admin.test.js`（3 项：token 鉴权 / kill 持久化重启保留 / resume-shadow 重启保持 shadow）。
- 新增 10 项证明脚本：`scripts/safety-proof.mjs`（11/11 PASS）。
- 一键复跑：`scripts/run-safety-proofs.sh`（5 个命令全部退出 0）。

## 验证结果
| 项目 | 结果 |
| --- | --- |
| 全量测试 | 592/592（unit 474 + integration 85 + audit 33） |
| Active Readiness 105 回归 | gates_passed=true，hard_violations=0 |
| Holdout 208 任务 | gates_passed=true，hard_violations=0 |
| Safety Proof 10 项 | 11/11 PASS（退出 0） |
| 版本一致性 | package.json / lock / README / Manifest = 1.0.0-phase2c-active-canary |

## 交付
交付包：`SmartRouter-Phase2-Canary-Safety-Sealed-交付包.zip`。完成后停止，不再增加新评测体系 / Task 分类 / 网站 / Dashboard。
