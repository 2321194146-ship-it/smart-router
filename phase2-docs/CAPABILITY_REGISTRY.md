# CAPABILITY_REGISTRY.md

Smart Router Mainline - Phase 2-A Capability Registry

## 1. 定位

从 `config.models` 构建模型能力索引（Shadow 版只读，不做在线更新、不修改生产配置），
为 Decision Engine 提供能力查询：capability / tier / provider / max_tokens / price / paid / enabled。

## 2. 标准能力集

| 能力 | 含义 |
| --- | --- |
| chat | 通用对话 |
| tool_use | 工具调用 |
| vision | 图像理解 |
| streaming | 流式输出 |
| reasoning | 推理能力（预留） |

## 3. 查询接口

| 接口 | 说明 |
| --- | --- |
| `getByModelId(id)` | 同 id 多 provider 条目 |
| `supports(id, cap)` | 是否支持某能力 |
| `summarize(id)` | 能力摘要（合并多 provider） |
| `match(task, opts)` | 按任务需求+预算筛选（纯本地，不影响生产候选） |

## 4. 测试（test/unit/intelligence.test.js）

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 按 id 查询（含不存在） | 1 条 / 0 条 | ✅ |
| supports 能力 | m1 tool_use ✓、m3 tool_use ✗、null 恒真 | ✅ |
| summarize 合并 | m2 含 vision、paid=true | ✅ |
| match 过滤 | 只留 tool_use + 非付费 | ✅ |
| hasCapability 大小写不敏感 | VISION vs vision | ✅ |

## 5. 数据来源

Registry 完全从 Phase1 的 `config.models` 构建，能力字段沿用现有 `capability` 数组，
无需额外配置；Shadow 模式零上游调用。
