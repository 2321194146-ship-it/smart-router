# Phase1/Phase2 能力数据源统一报告（Phase2-C 第 5 节）

## 问题
Phase1 `candidates.js` 的 `hasCapability` 只读 legacy `capability` 字符串数组；
使用新 `capabilities: {vision:100}` 对象配置的模型在 Phase1 构建候选时被过滤为 0 候选，
导致 Phase2 决策可用而 Phase1 执行无候选。

## 修复
- `src/router/candidates.js`：import `extractCapabilities` + `BINARY_CAPABILITY_THRESHOLD`
  复用统一数据源；判定阈值与 Phase2 policy.binaryThreshold 一致（默认 0.9）。
- `src/intelligence/capability-registry.js`：导出 `BINARY_CAPABILITY_THRESHOLD`；
  `hasCapability` 使用同一阈值（vision=95 视为支持，vision=60 视为不支持）。
- 兼容性：legacy 数组（字符串=完全支持，取 max）与新对象（0-100 归一化）共存。

## 验证（test/unit/intelligence.test.js C5 组）
- capabilities-only 模型（无 legacy 数组）→ vision 候选生成。
- capabilities vision=95 视为支持；vision=60 过滤。
- legacy capability 数组仍工作。
- extractCapabilities 对象 + 数组合并（max 语义）。
- registry hasCapability 阈值对齐。
