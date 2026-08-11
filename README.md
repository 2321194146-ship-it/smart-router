# Smart Router Mainline - Phase 1 生产核心底座

独立端口 **127.0.0.1:28788**，默认 `intelligence.mode = off`；包含本地运维 Dashboard，不包含公网产品前端和企业功能。

## 环境要求

- Node.js **>= 22**（与 package.json / package-lock.json 的 engines 一致，见 RELEASE_MANIFEST.json）

## Quick Start

1. 安装依赖（无第三方运行时依赖，lockfile 为空依赖）

```bash
npm ci
```

2. 准备配置

```bash
cp config/config.example.json config/local.json
# 编辑 config/local.json：
#   - 将 providers[].api_key 替换为你的真实 Key（config/local.* 已被 .gitignore 排除，不会入库）
#   - 如需调整 SQLite 数据目录，修改 server.data_dir
```

3. SQLite 数据目录

系统默认使用 SQLite 持久化（生产运行默认 SQLiteStore；仅当未配置 data_dir 时才回退 MemoryStore，仅用于测试）。

- 配置项：server.data_dir（config.example.json 默认 "./data"）
- 数据库文件：<data_dir>/smart-router.db
- 覆盖表：requests、attempts、cost_records、audit_records、finalized_requests、key_status、provider_health

4. 启动

```bash
npm start
# 或：node src/index.js config/local.json
```

5. 验证探活

```bash
curl -s http://127.0.0.1:28788/v1 | head -c 200
```

## 生产 HTTP 安全边界

- 绑定 `127.0.0.1`、`::1` 或 `localhost` 时保持本机兼容；绑定其他地址时，服务启动会强制要求环境变量 `SMART_ROUTER_API_TOKEN`（至少 16 个字符），主 API 使用 `Authorization: Bearer <token>`。
- `routing.max_concurrent` 现在由 HTTP 入口实际执行；超过上限返回 `503`，不会进入 Provider。
- 对外监听默认启用按客户端地址的内存固定窗口限流：每分钟 120 次；可用 `routing.rate_limit.enabled/window_ms/max_requests` 调整。多实例部署仍需在反向代理或共享限流层做全局限流。
- 非法 JSON、空对象和数组请求在路由前返回 `400`；不会触发上游调用。
- 流式 Provider 响应默认有 30 秒空闲超时和 `request_timeout_ms` 总时限；可用 `server.stream_idle_timeout_ms` / `server.stream_total_timeout_ms` 调整，超时会中止上游读取，避免连接和并发槽长期占用。
- Anthropic 原生 API 必须在对应 Provider 上显式设置 `api_type: "anthropic_native"`；仅有 `x-api-key` 或 `anthropic-version` 不会自动切换协议。原生路径保留 `output_config`、工具和系统字段，并原样透传 Anthropic Messages 响应/SSE。

## 本地运维 Dashboard

启动服务后打开 [http://127.0.0.1:28788/dashboard](http://127.0.0.1:28788/dashboard)。这是本机控制台，不是公网用户前端：

- 页面只在服务绑定 loopback（`127.0.0.1` / `::1` / `localhost`）时提供。
- 状态、Kill、Resume 操作仍需要 `SMART_ROUTER_ADMIN_TOKEN`；Token 只在页面内存中使用，不写入 localStorage、Cookie 或配置文件。
- 当前页面提供运行模式、Canary、Active 请求、成本、Fallback、停止原因和 Shadow 恢复操作。

完整验收门禁见 [RELEASE_ACCEPTANCE_PLAN.md](phase2-docs/RELEASE_ACCEPTANCE_PLAN.md)。

示例：

```bash
export SMART_ROUTER_API_TOKEN="替换为至少16个字符的随机值"
curl -H "Authorization: Bearer ${SMART_ROUTER_API_TOKEN}" \
  http://127.0.0.1:28788/v1/models
```

## 测试门禁（全部必须退出 0）

```bash
npm test                 # unit + integration + audit 全量（当前 633 项）
npm run test:unit        # 496 项
npm run test:integration # 103 项（含 SQLite 重启恢复、Finalize 事务原子性回滚与 100 并发事务、
                         #      三协议流式首内容前空 SSE Fallback、真实失败 Fallback、Cancel 证据对齐、
                         #      429 Key 冷却持久化与重启恢复、externalRequestId 持久化、
                         #      三协议 HTTP 无候选原子性）
npm run test:audit       # 33 项
npm run syntax:check     # src/index.js + src/server.js 语法
node scripts/release-evidence-check.mjs --json  # 发布前校验分支、提交、工作区和源文件哈希
node scripts/run-acceptance.mjs                  # 一键执行本次发布范围的全部门禁
```

## 运行闭环（Phase 1 Final Verified）

- KeyPool / CircuitBreaker / ProviderHealth 启动时从 SQLite 恢复状态，运行时写入 saveKeyStatus / saveProviderHealth
- 每个请求写 saveRequest，每个真实 Attempt 写 saveAttempt，每次成本写 saveCost
- Finalize 使用单次同步原子事务（finalizeRequestAtomic，BEGIN IMMEDIATE + 连续同步写入，无 await）：finalized 幂等占位 + requests 最终状态 + attempts + cost + audit 原子提交，失败整体回滚，可安全重试；100 个并发 Finalize 无 "cannot start a transaction within a transaction"
- 所有终态（含 no_candidate）统一走原子收尾入口；候选真实为空才记 no_candidate，协议内部未预期异常记 internal_error，不冒充 no_candidate
- 内部 requestId 全链唯一（sr_ 前缀），Chat / Responses / Anthropic 与所有 adapter 透传 context.requestId；客户端 x-request-id / x-correlation-id 仅作为 externalRequestId 保存，不作为数据库唯一主键
- 首内容前（未向客户端发送有效内容）允许尝试下一合法候选；首内容后禁止换模型 / 拼接 / 重复 Tool 调用，标记 incomplete
- HTTP Provider Failure/Fallback Integration：本地 Mock Provider 测试覆盖 Provider A 401/429/5xx 失败 → Provider B 成功 → Attempt 2 成功，同一 requestId 下完整记录 finalModel / finalProvider / Token / 成本 / 是否付费（本地 Mock 测试不称为真实外部 Provider Pilot）

## 真实外部 Provider Pilot 状态（部分完成）

当前已对 28788 直连的 ModelScope、NVIDIA、智谱、InternLM、Agnes 各执行一次受限真实请求，均通过；
其余历史 Provider 尚未迁移或未通过当前模型/配额验收，完整外部 Pilot 仍保持 pending。
不将脚本存在等同于 Pilot 通过；只有实际运行并产出脱敏 pilot-evidence.json 后才能更新为通过。

交付包提供脱敏复跑脚本（不含任何 Key），可按以下步骤执行真实外部 Pilot：

```bash
export SMARTROUTER_CONFIG=/path/to/config/local.json   # 含 Key 的本地配置（被 .gitignore 排除）
node scripts/pilot-sanitized.mjs --config "$SMARTROUTER_CONFIG" --out pilot-evidence.json
```

脚本只通过环境变量 / 外部配置文件读取 Key，自身不含任何密钥，输出 pilot-evidence.json（脱敏：content 截断、Key 字段不出现）。

## Phase 2-B（Active Readiness，分支 phase2-shadow，版本 1.0.0-phase2c-active-canary）

Decision Engine Active Readiness：把 Shadow 观测升级为具备真实任务能力匹配和预算控制能力的决策系统。系统继续运行 `intelligence.mode = shadow`，不开启 Active。

- 统一任务能力需求画像：Task Analyzer 输出 requiredCapabilities（8 能力 0-1）+ 13 任务类型（general_chat/coding/debugging/architecture/analysis/research/writing/summarization/translation/extraction/tool_orchestration/vision/structured_output）+ streaming 硬性要求
- 扩展 Model Capability Profile：capabilities 对象（0-1/0-100 规范化）+ reliability + latencyPriorMs + contextWindow + protocols；兼容旧字符串数组；同 modelId 不同 Provider 独立画像
- Streaming 硬约束：stream=true + 无 streaming → blocked（三协议流式全覆盖；非流式不阻止）
- 能力参与评分：能力匹配主导（权重 0.55）+ 强需求缺失惩罚 + 复杂任务降成本权重/简单任务成本优先；不把 tier 当作唯一质量替代品
- Budget 彻底修复：request_cost_exceeded 硬约束 + 标准化 price + wouldBlockAll + recommendation 成本（有价格配置非 null）
- Provider 健康只读：不稳定降分；样本 <5 静态先验；不扩大合法候选；不修改 Provider 状态
- Shadow 异步异常隔离（方案A）：await suggest() + try/catch + shadow_error 日志；建议落库后才 Finalize
- 对照状态：exact_match / model_match_provider_diff / policy_agreement / different / not_comparable

```json
{ "intelligence": { "mode": "shadow", "shadow": { "policy": { "tierPreference": true, "preferFree": true }, "retentionDays": 30 } } }
```

Active Readiness 评测：`node scripts/active-readiness-eval.mjs`（105 固定脱敏任务，22 类场景；
分类 100%、硬违规 0、可接受推荐 100%、终态 100%，门禁全 PASS）。报告见 evidence/active-readiness-eval-report.md。

端点声明：`config/real-pilot-config.template.json` 已改为 28788 直连五家已验收 Provider；历史 `config/local.real-pilot.json` 仍是 7878 过渡配置，不代表最终独立架构。评测同时使用确定性本地 Mock 与受限真实直连验收。

本阶段未实现：Active 全流量、公网网站、用户系统、商业化、Prompt 注入、
用户消息改写、Tool 自动控制、多模型并行/拼接、自动学习修改生产权重。5% 低风险 Active 须经独立验收。

## Phase 2-C Safety Sealed（版本 1.0.0-phase2c-active-canary）

Active Canary 控制器 8 项安全收口（独立验收后，仅修以下内容，未重建 Phase1/Shadow）：

- Fallback 链只保留 Decision 合法候选：decision.ranked 中 blocked==null 的候选才进入 orderedCandidates，blocked 候选绝不进入 Canary Fallback 链
- 指标只统计实际 Active 请求：activeRequests: Map<requestId, metadata>，Finalize 后清理；普通 Phase1 请求不进入指标、不触发自动停止
- 预算防御补齐：maxRequestCost / strictModel / estimatedCost（使用 ranked 完整条目）；完整 decision.task 传给 CanaryController
- 低风险资格（第一批 5% 排除）：toolsRequired / visionRequired / structuredOutputRequired / needsLongContext / strictModel / high风险 / 低置信度 / recommendation=null / 硬能力 blocked / 非允许协议
- 真正可操作的 Kill Switch（方案A 本地管理接口）：GET /_smart-router/intelligence/status、POST /_smart-router/intelligence/kill、POST /_smart-router/intelligence/resume-shadow；仅 127.0.0.1 + Admin Token（SMART_ROUTER_ADMIN_TOKEN，不入 Git）；状态写入 SQLite app_state，重启后仍保持；resume-shadow 只恢复 Shadow，不自动恢复 Active
- 首批 Canary 配置修正：allowedAgents: ["claude-code"]
- 指标语义修正：连续错误真连续计数（成功即清零）；停止条件仅基于 Active 请求
- 发布一致性：package.json / package-lock.json / README / RELEASE_MANIFEST 统一 1.0.0-phase2c-active-canary；Git 证据三处统一

验证：592/592 测试全绿；Active Readiness 105 回归 gates PASS；Holdout 208 任务 gates PASS；scripts/safety-proof.mjs 10 项证明 11/11 PASS；scripts/run-safety-proofs.sh 5 个命令全部退出 0。报告见 phase2-docs/CANARY_SAFETY_SEALED_REPORT.md。

最终提交：见 evidence/git-commit-sha.txt 与 RELEASE_MANIFEST.json 的 commit 字段。

## Phase 2-C 5% Canary Live Pilot（127.0.0.1:28788 内部实验）

真实 5% 低风险 Active Canary 启动补丁（仅完成以下内容，未新增评测体系 / Task 分类 / 公网网站 / 决策算法；本地运维 Dashboard 独立提供）：

- 允许 Claude Code 低风险流式请求参与 Canary：needsStreaming 不再直接排除；流式请求须 protocol=anthropic + agentId=claude-code + 低风险任务类型 + 所有执行候选支持 streaming；流式硬能力保留（stream=true + 模型不支持 streaming → 候选 blocked，不进 Fallback）
- 自动停止状态立即持久化：apply 阶段（budget_violation）与 Finalize 阶段（budget_exceeded / first_byte_switch / repeated_tool / incomplete_rise / consecutive_provider_errors / consecutive_no_candidate）停止后立即写入 SQLite app_state.canary.killed；持久化失败不影响进程内停止采样；重启后仍 stopped，不恢复 5% 采样
- 首批 Canary 严格限制 Anthropic：allowedProtocols=["anthropic"]；Responses / Chat 本轮禁止进入真实 Active Canary（Responses text.format 问题进入维护清单，不阻塞本轮）
- Live Pilot 结果（node scripts/canary-live-pilot.mjs）：127.0.0.1:28788 发送 456 个 Claude Code Anthropic 流式请求，active=20（5% 确定性采样）；20 个 Active 全部重排到 Canary Primary（canary-best），436 个非采样请求走 Phase1（phase1-first）；completed 456；Kill Switch 验证：kill → 重启 stopped=true（restored）→ resume-shadow 回 shadow（canaryEnabled=false）
- 保护规则：不修改 7878/17878；不使用生产全部 Key（Mock / 低额度测试链路）；不对外开放（127.0.0.1）；Admin Token 只放环境变量；Kill 接口仅 127.0.0.1；不开启 Cloud 收费（Cloud Billing Blocker 保持标记，网站公开收费前必须单独解决）

验证：600/600 测试全绿（unit 478 / integration 89 / audit 33）；流式资格测试 5 项；自动停止重启持久化测试 4 项（incomplete_rise / provider_errors / first_byte_switch / budget_violation apply）；Live Pilot evidence 见 evidence/canary-live-pilot-evidence.json。报告见 phase2-docs/CANARY_LIVE_PILOT_REPORT.md。

## 关于交付包（ZIP）内容说明

- 交付包根目录含全部报告（*_REPORT.md、READ_ME_FIRST.md、RELEASE_MANIFEST.json）
- source/ 为干净源码快照（不含 .git / node_modules / 数据库 / Key / 生产配置）
- evidence/ 目录**包含脱敏的 server-output.log** 及其它运行证据（npm-test-output.txt、node-version.txt 等）。因此**不要声称"ZIP 不含日志"**——日志以脱敏形式存在，用于验收证据；source/ 快照内不含日志
