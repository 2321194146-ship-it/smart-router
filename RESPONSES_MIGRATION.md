# Responses API 迁移分析（Smart Router 6.1.1 → 6.2.0）

> 本文件依据 **只读参考** 旧 7878 网关（`/Users/lijie/CodeBuddy/20260703165750/智能路由/proxy.mjs`）
> 与第三方转换库 `mimo2codex`（`node_modules/mimo2codex/dist/translate/*`）整理。
> 旧 7878 在整理过程中 **未修改、未停止、未覆盖、未复制其配置/数据库/日志/Key**。
> 新版代码为 **重新实现**（不是复制 `proxy.mjs`），仅沿用其经过 Codex 实战验证的转换规则。

## 1. 旧 7878 的 Responses 相关入口与转换函数

| 位置（旧 proxy.mjs） | 作用 |
|---|---|
| `proxy.mjs` `/v1/responses` + `/responses` 路由（约 1540–1620 行） | 入口；鉴权、解析 body、调用 `mimo2codex` 的 `reqToChat` / `respToResponses` / `pipeChatStreamToResponses` |
| `mimo2codex/translate/reqToChat.js` | **请求转换**：Responses `input`/instructions/工具/图片/角色/function_call → Chat Completions messages |
| `mimo2codex/translate/respToResponses.js` | **非流式响应转换**：Chat Completions JSON → Responses 对象（id/created_at/output/usage/error/incomplete_details） |
| `mimo2codex/translate/streamToSse.js` | **流式转换**：Chat SSE → Responses SSE（response.created / output_item.added / content_part.added / output_text.delta / function_call_arguments.delta / output_item.done / completed 等） |
| `mimo2codex/util/sse.js` | SSE 解析与 `makeServerResponseSink`（done/error/failed 事件封装、timer/reader 清理） |

旧实现没有显式的 `native`/`chat-adapter` 区分：**所有 Provider 一律走 chat-adapter 转换**（因为旧 7878 对接的下游都是 Chat Completions 端点）。这是本阶段需要新增的核心能力。

## 2. 已被 Codex 实际使用的功能（必须保留）

- `input` 为字符串、为 message/item 数组。
- `instructions` → system 消息。
- 角色 `developer` / `system` / `user` / `assistant`（developer 原样保留）。
- `input_text` / `input_image`（URL 与 data URL）。
- 前一轮 `assistant` 消息（含 `function_call`）。
- `function_call_output`（`call_id` + `output`）→ 下一轮 tool 消息。
- function 工具定义与 `tool_choice`。
- `text.format`（json_schema / json_object）→ `response_format`。
- 非流式 `output_text` + `function_call` item；流式 `output_text.delta` + `function_call_arguments.delta`。
- `usage` 映射（`input_tokens` / `output_tokens` / `total_tokens` + 缓存/推理明细）。
- 请求 ID 贯穿、成本与请求记录（旧实现记录 `protocol` 字段）。

## 3. 可保留的逻辑（重新实现于新版）

- `responsesToChat`：input/instructions/角色/工具/图片/tool_choice/format 转换规则 **原样沿用**。
- `chatToResponses`：output/usage/status/incomplete_details 映射规则 **原样沿用**（含 `call_id = chat tool_call.id`，保证往返一致）。
- 流式事件序列与 `sequence_number` 单调递增规则 **原样沿用**。
- 三层错误兜底（Provider/Model/Key）**直接复用 6.1.1 的 `routeChatCompletion`/`executeCandidates`**，不重写。

## 4. 必须重写/新增的逻辑

- **协议适配层拆分**：旧代码把 Responses 逻辑堆在 `proxy.mjs` 一个大函数里；新版拆为 `src/protocols/responses.js`（非流式 + 校验）与 `src/protocols/responses-stream.js`（流式），`server.js` 只编排。
- **`native` 模式**：新增。Provider 配置 `responses_mode: "native"` 时，请求原样透传到 `${base_url}/responses`，非流式响应与 SSE 事件原样返回（不经 chat 转换）。`chat-adapter` 模式走转换。
- **`callProviderChat` 支持 `endpoint`/`passthrough`**：新增第 7 个参数 `opts`，`endpoint:'responses'` 时打到 `/responses` 并跳过 chat 专属的字段裁剪与 prompt 注入。
- **`routeResponses`**：复用 `buildCandidates` + `executeCandidates`，通过 `makeUpstream` 按候选 Provider 的 `responses_mode` 选择 endpoint；返回结果携带 `mode`（`native`/`adapter`）供 `server.js` 决定如何转换。
- **未配置 `responses_mode` 的安全默认**：默认 `chat-adapter` 并显式日志，绝不随机猜测导致重复计费。
- **适配器不支持字段的明确报错**：`previous_response_id` / `reasoning` / 非 function 工具类型 → 抛出清晰错误；`routeResponses` 会据此跳过 adapter 候选，仅由 native 候选服务；若无 native 候选则统一返回 422。

## 5. 本阶段不支持的字段/功能

- 原生专属工具类型（web_search / file_search / code_interpreter / computer_use / mcp 等）：`chat-adapter` 直接报错；`native` 透传由 Provider 处理。
- `previous_response_id` 本地状态存储：新版不维护 conversation store，`chat-adapter` 报错要求传完整上下文；`native` 透传。
- 流式 `reasoning` item（o1 类）：`chat-adapter` 不支持（报错）；`native` 透传。
- 后台异步任务 / Webhook / 托管式 Web Search / File Search / Computer Use / MCP 执行 / 图片生成 / Code Interpreter / 完整 conversation 服务 / Agent 认知增幅 / 多 Agent 协作 —— 均 **不在本阶段范围**（见任务书第十二节）。
- 多 choice（`choices[1+]`）：本阶段只处理 `choices[0]`（下游 Provider 均单 choice）。
- `truncation` / `include` / `top_logprobs` 等 benign 未知字段：`chat-adapter` 会透传到 chat body（Provider 忽略未知字段），不单独报错，但不在文档承诺支持列表内。

## 6. 旧实现的风险与技术债（本阶段规避）

| 旧实现问题 | 新版处理 |
|---|---|
| Responses 逻辑全部堆在 `proxy.mjs` 一个大函数，难以测试 | 拆为 `protocols/responses.js` + `responses-stream.js`，纯函数可单测 |
| 无 `native`/`adapter` 区分，所有 Provider 强制 chat 转换 | 新增 `responses_mode` 显式区分 |
| `responses_mode` 缺失时旧代码间接假设全部 chat | 缺失 → 安全默认 `chat-adapter` + 明确日志 |
| 不支持字段（如 `previous_response_id`）可能静默丢弃 | 明确 422，绝不假装成功 |
| 旧代码用第三方库 `mimo2codex`（`createRequire` 加载） | 新版自包含重新实现，无运行时第三方依赖 |
| 流式 `reader`/`timer` 清理分散 | `responses-stream.js` 统一在 `finally` 清理 `reader`/`setInterval`/`abort listener` |

## 7. 新版各功能最终模块归属

| 功能 | 模块 |
|---|---|
| 请求校验（4xx） | `src/protocols/responses.js` → `validateResponsesRequest` |
| Responses → Chat 转换 | `src/protocols/responses.js` → `responsesToChat` |
| Chat → Responses 转换（非流式） | `src/protocols/responses.js` → `chatToResponses` |
| 统一错误结构 | `src/protocols/responses.js` → `responsesError` |
| Chat SSE → Responses SSE | `src/protocols/responses-stream.js` → `pipeChatStreamToResponses` |
| 原生 Responses SSE 透传 | `src/protocols/responses-stream.js` → `forwardNativeStream` |
| 端点路由 / 鉴权 / 限流 / 编排 / DB 记录 | `src/server.js`（`/v1/responses` + `/responses`） |
| 候选选择 + 三层兜底 + `native`/`adapter` 调度 | `src/provider-client.js` → `routeResponses` + `callProviderChat(opts)` |
| Provider 能力声明 | `config.providers[*].responses_mode` |
