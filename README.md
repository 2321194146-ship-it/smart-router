# Smart Router Mainline - Phase 1 生产核心底座

独立端口 **127.0.0.1:28788**，intelligence.mode = off，不包含智能决策 / Dashboard / 企业功能。

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

## 测试门禁（全部必须退出 0）

```bash
npm test                 # unit + integration + audit 全量（当前 443 项）
npm run test:unit        # 345 项
npm run test:integration # 65 项（含 SQLite 重启恢复、Finalize 事务原子性回滚与 100 并发事务、
                         #      三协议流式首内容前空 SSE Fallback、真实失败 Fallback、Cancel 证据对齐、
                         #      429 Key 冷却持久化与重启恢复、externalRequestId 持久化、
                         #      三协议 HTTP 无候选原子性）
npm run test:audit       # 33 项
npm run syntax:check     # src/index.js + src/server.js 语法
```

## 运行闭环（Phase 1 Final Verified）

- KeyPool / CircuitBreaker / ProviderHealth 启动时从 SQLite 恢复状态，运行时写入 saveKeyStatus / saveProviderHealth
- 每个请求写 saveRequest，每个真实 Attempt 写 saveAttempt，每次成本写 saveCost
- Finalize 使用单次同步原子事务（finalizeRequestAtomic，BEGIN IMMEDIATE + 连续同步写入，无 await）：finalized 幂等占位 + requests 最终状态 + attempts + cost + audit 原子提交，失败整体回滚，可安全重试；100 个并发 Finalize 无 "cannot start a transaction within a transaction"
- 所有终态（含 no_candidate）统一走原子收尾入口；候选真实为空才记 no_candidate，协议内部未预期异常记 internal_error，不冒充 no_candidate
- 内部 requestId 全链唯一（sr_ 前缀），Chat / Responses / Anthropic 与所有 adapter 透传 context.requestId；客户端 x-request-id / x-correlation-id 仅作为 externalRequestId 保存，不作为数据库唯一主键
- 首内容前（未向客户端发送有效内容）允许尝试下一合法候选；首内容后禁止换模型 / 拼接 / 重复 Tool 调用，标记 incomplete
- HTTP Provider Failure/Fallback Integration：本地 Mock Provider 测试覆盖 Provider A 401/429/5xx 失败 → Provider B 成功 → Attempt 2 成功，同一 requestId 下完整记录 finalModel / finalProvider / Token / 成本 / 是否付费（本地 Mock 测试不称为真实外部 Provider Pilot）

## 真实外部 Provider Pilot 状态（pending）

当前 Phase 1 的验证全部基于本地 Mock Provider 的 HTTP Provider Failure/Fallback Integration 测试，
**尚未执行真实外部 Provider Pilot**（RELEASE_MANIFEST.json 中 pilot_summary.status = "pending_external_pilot"）。
不将脚本存在等同于 Pilot 通过；只有实际运行并产出脱敏 pilot-evidence.json 后才能更新为通过。

交付包提供脱敏复跑脚本（不含任何 Key），可按以下步骤执行真实外部 Pilot：

```bash
export SMARTROUTER_CONFIG=/path/to/config/local.json   # 含 Key 的本地配置（被 .gitignore 排除）
node scripts/pilot-sanitized.mjs --config "$SMARTROUTER_CONFIG" --out pilot-evidence.json
```

脚本只通过环境变量 / 外部配置文件读取 Key，自身不含任何密钥，输出 pilot-evidence.json（脱敏：content 截断、Key 字段不出现）。

## Phase 2-B（Active Readiness，分支 phase2-shadow，版本 1.0.0-phase2-shadow）

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

端点声明：ModelScope 直连真实 Provider；Anthropic/Responses 经 7878 网关转发（真实链路，非 28788 直连官方）；评测使用确定性本地 Mock。

本阶段未实现：Active 全流量、Dashboard、网站、用户系统、商业化、Prompt 注入、
用户消息改写、Tool 自动控制、多模型并行/拼接、自动学习修改生产权重。5% 低风险 Active 须经独立验收。

## 关于交付包（ZIP）内容说明

- 交付包根目录含全部报告（*_REPORT.md、READ_ME_FIRST.md、RELEASE_MANIFEST.json）
- source/ 为干净源码快照（不含 .git / node_modules / 数据库 / Key / 生产配置）
- evidence/ 目录**包含脱敏的 server-output.log** 及其它运行证据（npm-test-output.txt、node-version.txt 等）。因此**不要声称"ZIP 不含日志"**——日志以脱敏形式存在，用于验收证据；source/ 快照内不含日志
