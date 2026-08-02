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
npm test                 # unit + integration + audit 全量（当前 437 项）
npm run test:unit        # 345 项
npm run test:integration # 59 项（含 SQLite 重启恢复、Finalize 事务原子性回滚、requestId 全链唯一、
                         #      三协议流式首内容前空 SSE Fallback、真实失败 Fallback、Cancel 证据对齐、
                         #      429 Key 冷却持久化与重启恢复、externalRequestId 持久化）
npm run test:audit       # 33 项
npm run syntax:check     # src/index.js + src/server.js 语法
```

## 运行闭环（Phase 1 Final Verified）

- KeyPool / CircuitBreaker / ProviderHealth 启动时从 SQLite 恢复状态，运行时写入 saveKeyStatus / saveProviderHealth
- 每个请求写 saveRequest，每个真实 Attempt 写 saveAttempt，每次成本写 saveCost
- Finalize 使用单数据库事务（finalizeRequestTransaction）：finalized 幂等占位 + requests 最终状态 + attempts + cost + audit 原子提交，失败整体回滚，可安全重试
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

## 关于交付包（ZIP）内容说明

- 交付包根目录含全部报告（*_REPORT.md、READ_ME_FIRST.md、RELEASE_MANIFEST.json）
- source/ 为干净源码快照（不含 .git / node_modules / 数据库 / Key / 生产配置）
- evidence/ 目录**包含脱敏的 server-output.log** 及其它运行证据（npm-test-output.txt、node-version.txt 等）。因此**不要声称"ZIP 不含日志"**——日志以脱敏形式存在，用于验收证据；source/ 快照内不含日志
