# PILOT_REPORT.md

Smart Router Mainline - Phase 1 真实外部 Provider Pilot 报告
执行日期：2026-08-03 ｜ 端口：127.0.0.1:28788（独立，未触碰 7878/17878）

## 1. 真实端点（非 Mock）

| 能力 | 端点 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 chat | `https://api-inference.modelscope.cn/v1`（modelscope 直连） | 真实请求/真实模型 |
| Anthropic Messages | `http://127.0.0.1:7878/v1/messages`（gateway 转发） | 环境标准 Anthropic 网关，背后真实推理 |
| Responses | `http://127.0.0.1:7878/v1/responses`（gateway 转发） | 同上 |
| 失败源（真实 401） | modelscope 真实 URL + 无效 key | 真实鉴权失败 |

所有请求均经 28788 上的 Smart Router 发出；Pilot 脚本（脱敏）不包含任何 Key。

## 2. 九项执行结果

| # | 项目 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 真实 OpenAI 兼容请求 | 200，content=PILOT_OK，usage={11,21,32} | evidence/pilot-evidence.json |
| 2 | 真实 Anthropic Messages | 200，stop_reason=end_turn，usage={input:147,output:20} | 同上 |
| 3 | 真实 Responses | 200，id=resp_*，output_text=PILOT_OK | 同上（上游 429 时自动重试） |
| 4 | 真实 tool_use/tool_result | 两轮 200，tool_calls=1，args 解析后回填 | 同上 |
| 5 | 真实流式客户端取消 | aborted=true（5.6KB 后客户端断开） | 同上 |
| 6 | Provider A 真实失败→B 成功 | modelscope-badkey 真实 401 → fallback gateway 200，content=FALLBACK_OK，attempts=3 | 同上 + DB |
| 7 | 禁付费 | 402 Payment Required，error.type=budget_exceeded，无 cost | 同上 |
| 8 | strict 模型 | 存在模型→200 STRICT_OK；不存在模型→503 no_candidate（attempt_count=0） | evidence/pilot-strict-evidence.json |
| 9 | 真实 usage/Token/成本/Attempt | cost_records=6（真实 token），attempts=10，fallback 双 attempt，completed=6 | evidence/pilot-db-evidence.json |

### 通过率：9/9（Pilot 7/7 + strict 2/2，DB 校验全 PASS）

## 3. 数据库记录（pilot-data/smart-router.db）

| 计数项 | 值 |
| --- | --- |
| requests / finalized | 8 / 8 |
| attempts | 10（含 fallback 401 尝试与成功尝试） |
| cost_records | 6（真实 usage：modelscope 11/21、293/74；gateway 147/20） |
| audit_records | 8（completed=6、client_aborted=1、budget_exceeded=1） |

DB 校验断言全部 PASS：真实 token 记录、预算拒绝无 cost、fallback 双 attempt、attempt providers 覆盖 modelscope/gateway/modelscope-badkey/internlm。

## 4. Pilot 暴露并修复的 3 个真实缺陷

1. **budget_exceeded 错误类型映射缺失**：三个协议（chat/anthropic/responses）的 error type 映射
   未包含 budget_exceeded，导致 402 响应 error.type=internal_error。已修复为
   budget_exceeded / invalid_request_error / insufficient_quota。
2. **失败响应兜底归因错误**：handleFailure 在无上游 error 时默认 internal_error，
   未按 outcome 归因。已新增 `outcomeToOpenAIType`（budget_exceeded→budget_exceeded、
   no_candidate→service_unavailable、provider_error→server_error）。
3. **成本 usage 归零**：ProviderClient.parseUsage 返回驼峰字段（promptTokens），
   而 CostTracker.calculateCostRecord 的 pickTokens 只查下划线字段（prompt_tokens），
   导致 cost_records.usage 全为 0。已修复 pickTokens 兼容驼峰。

修复后 443/443 测试通过，Pilot 复跑 9/9。

## 5. 约束遵守

- 未修改 7878 / 17878（7878 全程保持监听）。
- 28788 独立运行，Pilot 结束后关闭。
- 全程未使用 Mock 结果代替真实 Pilot。
- 证据脱敏：content 截断、不含任何 Key / Authorization 头（日志 grep 校验 0 匹配）。
