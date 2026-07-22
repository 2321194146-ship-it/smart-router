# Smart Router v6.1 — 前端后端接口矩阵

## 后端已实现接口

| 方法      | 路径                         | 认证 | 用途                       | 状态 |
|-----------|------------------------------|------|----------------------------|------|
| GET       | `/health`                    | 否   | 健康检查                   | ✅   |
| GET       | `/stats`                     | 是   | 运行统计/拓扑              | ✅   |
| GET       | `/api/recent`                | 是   | 近期请求日志               | ✅   |
| GET/POST  | `/api/providers`             | 是   | 管理 Provider 列表         | ✅   |
| GET/POST  | `/api/models`                | 是   | 管理模型列表               | ✅   |
| DELETE    | `/api/models/:name`          | 是   | 删除模型                   | ✅   |
| GET       | `/api/routes`                | 是   | 路由配置                   | ✅   |
| GET       | `/api/cost`                  | 是   | 成本查询                   | ✅   |
| GET       | `/api/config`                | 是   | 运行时配置（脱敏）         | ✅   |
| POST      | `/api/system/reload`         | 是   | 重载配置                   | ✅   |
| POST      | `/v1/chat/completions`       | 是   | OpenAI 协议代理            | ✅   |
| POST      | `/v1/messages`               | 是   | Anthropic 协议代理         | ✅   |
| WebSocket | `/ws`                        | 是   | 实时推送                   | ✅   |
| GET       | `/`                          | 否   | 前端静态页                 | ⚠️ 需前端构建 |

## 前端可能需要但后端不存在的接口

| 请求路径                          | 说明           | 建议 |
|-----------------------------------|----------------|------|
| `/api/config/providers`           | 仅 Provider 配置 | 前端改成调用 `/api/providers` |
| `/api/config/models`              | 仅模型配置     | 前端改成调用 `/api/models` |
| `/api/virtual-keys`               | 虚拟 Key 管理  | 未实现，不在 v6.1 范围内 |
| `/api/key-management`             | Key 管理 CRUD  | 未实现，通过 `/api/providers` POST 管理 |
| `/api/routes/cooldown`            | 冷却配置       | 前端直接读取 `/api/routes` |
| `/api/logs`                       | 日志查询       | 前端改成调用 `/api/recent` |
| `/api/logs/export`                | 日志导出       | 未实现 |
| `/api/user`                       | 用户管理       | 不在 v6.1 范围内 |
| `/api/rate-limit`                 | 速率限制配置   | 未暴露独立 API |
| `/api/guardrails`                 | 护栏规则       | 未暴露独立 API |
| `/api/cache`                      | 缓存管理       | 未暴露独立 API |
| `/api/model-router`               | 路由规则管理   | 未实现 |

## 认证方式

- 无 `adminToken` 时：仅 `127.0.0.1` 本机可访问所有 API
- 有 `adminToken` 时：`Authorization: Bearer <token>` 或 `X-Api-Key: <token>`

## 数据流

```
前端 ↔ /v1/chat/completions (SSE/non-streaming)
    → buildCandidates() → executeCandidates()
        → callProviderChat() → 下游 Provider
    
前端 ↔ /api/providers GET/POST
    → loadRawConfig() / saveRawConfigAtomic()

前端 ↔ /api/config GET
    → sanitizeConfigForClient() (递归脱敏)

WebSocket /ws → 实时推送运行统计 (5s 间隔)
```
