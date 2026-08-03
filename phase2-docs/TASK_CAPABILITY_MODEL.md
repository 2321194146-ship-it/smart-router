# TASK_CAPABILITY_MODEL.md

Smart Router Mainline - Phase 2-B 统一任务能力需求画像

## 1. 画像结构

Task Analyzer 输出统一能力需求画像（0-1 需求强度）：

```json
{
  "requiredCapabilities": {
    "chat": 1.0,
    "coding": 0.0,
    "reasoning": 0.0,
    "tool_use": 0.0,
    "vision": 0.0,
    "structured_output": 0.0,
    "long_context": 0.0,
    "streaming": 0.0
  }
}
```

`hardCapabilities`：需求 = 1.0 的能力（缺失即 blocked）。

## 2. 13 种任务类型与能力需求模板

| 任务类型 | chat | coding | reasoning | tool_use | vision | structured_output | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| general_chat | 1.0 | — | — | — | — | — | 通用对话 |
| coding | 1.0 | 1.0 | — | — | — | — | 代码生成 |
| debugging | 1.0 | 1.0 | 0.85 | — | — | — | 复杂代码调试：coding 高、reasoning 高 |
| architecture | 1.0 | 0.8 | 0.8 | — | — | — | 架构设计 |
| analysis | 1.0 | — | 0.85 | — | — | — | 分析推理 |
| research | 1.0 | — | 0.8 | — | — | — | 研究调研 |
| writing | 1.0 | — | — | — | — | — | 写作 |
| summarization | 1.0 | — | 0.3 | — | — | — | 摘要：reasoning 要求低、成本优先 |
| translation | 1.0 | — | — | — | — | — | 翻译 |
| extraction | 1.0 | — | — | — | — | 0.3 | 提取改写 |
| tool_orchestration | 1.0 | — | — | 1.0 | — | — | 工具调用 |
| vision | 1.0 | — | — | — | 1.0 | — | 图像理解 |
| structured_output | 1.0 | — | — | — | — | 1.0 | 结构化输出 |

## 3. 叠加规则（信号 → 硬性要求）

| 信号 | 能力 | 强度 |
| --- | --- | --- |
| stream=true | streaming | 1.0（硬性） |
| 长上下文（token 估算 > 6000 或轮次 > 12） | long_context | 1.0 |
| 请求含 tools 数组 | tool_use | 1.0 |
| 消息含 image 块 | vision | 1.0 |
| 结构化输出提示（output as json 等） | structured_output | >= 0.8 |
| 调试/复杂推理信号 | reasoning | >= 0.8 |

## 4. 示例

```text
复杂代码调试（debugging）：
  coding = 1.0（硬），reasoning = 0.85（软高），tool_use 视请求

普通摘要（summarization）：
  chat = 1.0，reasoning = 0.3（低），成本优先

stream=true：
  streaming = 1.0（硬性要求，缺失即 blocked）
```

## 5. 实现约束

- 纯本地计算，无 LLM 调用、无上游请求。
- 不修改消息内容（禁止用户消息改写）。
- 不附加任何 System Prompt（能力需求通过结构化元数据表达）。
