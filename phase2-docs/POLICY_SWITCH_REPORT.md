# Policy 配置真实生效报告（Phase2-C 第 6 节）

## 问题
preferFree / tierPreference 配置切换不改变评分结果（配置形同虚设）。

## 修复（src/intelligence/policy.js + decision-engine.js）
1. preferFree=true：无强 soft 需求任务（coding/reasoning 需求 <0.7）中免费候选
   成本分下限提升至 0.6 —— "质量达标后优先免费"；复杂推理/编码任务仍以能力为主，
   免费奖励不得压过明显能力差距。
2. preferFree=false：paidPenalty 不生效（付费无惩罚）。
3. tierPreference=false：tier 权重置 0（tier 不参与排序）。
4. 权重归一化：总分按实际权重和归一，避免配置调整导致总分失衡。
5. 确定性 Tie-Breaker（pickBest）：score → capability → reliability → cost →
   latency → Phase1 顺序（用户指定顺序，无 tier）；同分可复现。

## 验证（test/unit/policy-toggle.test.js，6 项）
- preferFree 切换改变免费候选评分。
- preferFree=false 移除付费惩罚。
- tierPreference=false 缩小 tier 差距。
- Tie-Breaker 顺序（capability → reliability → order）。
- pickBest 跳过 blocked。
- Decision Engine 层 tierPreference=false 让能力胜出（t3 更强模型击败 t1）。
