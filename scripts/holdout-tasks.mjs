// scripts/holdout-tasks.mjs
// Smart Router Mainline - Phase 2-C
// Holdout 对抗评测任务定义（≥200，独立于 Phase2-B 的 105 回归集）。
// 设计原则：
//   - 不复制 active-readiness-eval 的关键字模板（同义词 / 无关键词 / 中英混合）
//   - 覆盖 Phase2-C 修复语义：工具可用 vs 必需、协议级结构化、CJK/大Schema Token 估算、
//     60-99 等级能力分、capabilities-only / legacy-only 模型、preferFree / tierPreference 切换、
//     歧义与 null 安全拒绝、Provider 健康、预算边界、strict、no-paid

export const TASKS = [];
const add = (category, expectedType, body, meta = {}) => {
  TASKS.push({ id: meta.id || ('h' + String(TASKS.length + 1).padStart(3, '0')), category, expectedType, body, ...meta });
};

const chatBody = (text, extra = {}) => ({ model: 'auto', messages: [{ role: 'user', content: text }], ...extra });

// ===========================================================================
// A. 同义词类（分类器需识别同义表达，不依赖模板关键词）
// ===========================================================================
// --- summarization 同义词 (EN 8 + ZH 6 = 14) ---
for (const t of [
  'Condense the article into key points',
  'Give me the gist of this report',
  'What are the main takeaways from this document?',
  'Boil this down to the essentials',
  'Distill the meeting notes into a short list',
  'TLDR this long thread for me',
  'Wrap up this discussion briefly',
  'Hit the highlights of this memo',
]) add('syn_summarization', 'summarization', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95', 'H-smallctx'], hardCaps: ['chat'] });
for (const t of [
  '把这段文字浓缩成要点',
  '给我这份报告的重点内容',
  '总结一下今天的会议记录',
  '提炼出这篇文章的核心观点',
  '简练地概括这份文档',
  '用三句话概括这篇文章',
]) add('syn_summarization_zh', 'summarization', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95', 'H-smallctx'], hardCaps: ['chat'] });

// --- translation 同义词 (EN 5 + ZH 5 = 10) ---
for (const t of [
  'Convert this paragraph into Japanese',
  'Render this email in German',
  'Give me a French version of this sentence',
  'Turn this text into Spanish',
  'Write this in Portuguese',
]) add('syn_translation', 'translation', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  '把这段话翻成英文',
  '将这份合同翻译成日语',
  '帮我用德语写这封邮件',
  '把这个句子转成法语',
  '这段中文怎么用英语表达',
]) add('syn_translation_zh', 'translation', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// --- extraction 同义词 (EN 5 + ZH 5 = 10) ---
for (const t of [
  'Pull out all the dates from this text',
  'List every email address in this document',
  'Pick out the product names from this review',
  'Grab the phone numbers from this page',
  'Find all the key figures in this report',
]) add('syn_extraction', 'extraction', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  '抓出文中的所有日期',
  '提取这段文字里的邮箱地址',
  '找出评论中的产品名称',
  '整理出这份名单里的电话号码',
  '把文中的数字都挑出来',
]) add('syn_extraction_zh', 'extraction', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// --- writing 同义词 (EN 5 + ZH 5 = 10) ---
for (const t of [
  'Compose a thank-you note to my colleague',
  'Draft a short announcement for the team',
  'Pen a farewell message for a coworker',
  'Create a catchy tagline for my startup',
  'Fashion a poem about autumn leaves',
]) add('syn_writing', 'writing', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  '帮我写一封感谢信给客户',
  '起草一份团队通知',
  '写一段告别致辞',
  '为我的产品想一句广告语',
  '作一首关于秋天的短诗',
]) add('syn_writing_zh', 'writing', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// --- analysis 同义词 (EN 5 + ZH 5 = 10) ---
for (const t of [
  'Weigh the pros and cons of working from home',
  'Break down the causes of inflation',
  'Assess the impact of this policy on small businesses',
  'Reason through the tradeoffs of the two options',
  'Evaluate which investment strategy fits a risk-averse investor',
]) add('syn_analysis', 'analysis', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat', 'H-bigctx'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  '权衡一下在家办公的利弊',
  '拆解一下通货膨胀的成因',
  '评估这项政策对小企业的影响',
  '推理这两个方案的取舍',
  '判断哪种投资策略适合保守型投资者',
]) add('syn_analysis_zh', 'analysis', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat', 'H-bigctx'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });

// ===========================================================================
// B. 无关键词 / 含蓄意图类（不依赖显式关键词，验证不误判）
// ===========================================================================
for (const t of [
  'I need help with my homework tonight',
  'This math problem has me stuck',
  "Let's just chat about what happened today",
  'The weather is really nice out',
  'Do you have any fun facts?',
  'I am feeling a bit tired today',
  'What games do you like?',
  'Tell me about your weekend',
  'Any good movies lately?',
  'How was your lunch?',
]) add('no_keyword_chat', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95', 'H-smallctx'], hardCaps: ['chat'] });

// 含蓄推理（无 reasoning/analysis 关键词，但含逻辑意图）
for (const t of [
  'Alice is taller than Bob, and Bob is taller than Charlie. Who is the tallest?',
  'If every cat is an animal, and every animal is alive, are all cats alive?',
  'Two trains leave at the same time; one is faster. Calculate which arrives first if distance is equal.',
  'A shop sells apples at 3 for $2. Calculate how much 9 apples cost.',
  'Tom has twice as many marbles as Jerry. Jerry has 5. Calculate how many Tom has.',
]) add('implicit_reasoning', 'analysis', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });

// ===========================================================================
// C. 工具可用 vs 工具必需（第二节）
// ===========================================================================
const toolDefs = [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } } }];
const readTools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
for (const t of [
  'Thanks! That makes sense now.',
  'Great explanation, appreciate it.',
  'What do you think about this idea?',
  'I see, got it.',
  'Hmm, let me think about that.',
]) add('tools_present_unneeded', 'general_chat', { model: 'auto', messages: [{ role: 'user', content: t }], tools: readTools }, { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-tool', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'] });
for (const t of [
  'Explain why my disk is full and its possible causes.',
]) add('tools_present_unneeded_analysis', 'analysis', { model: 'auto', messages: [{ role: 'user', content: t }], tools: readTools }, { acceptable: ['H-reason', 'H-coding95', 'H-chat', 'H-bigctx'], forbidden: ['H-cheap'], hardCaps: ['chat'] });
// 502 error 语境 → coding 更合理（'error' 强信号）
add('tools_present_unneeded_coding', 'coding', { model: 'auto', messages: [{ role: 'user', content: 'What could cause a 502 error here? Explain.' }], tools: readTools }, { acceptable: ['H-coding95', 'H-reason', 'H-chat'], forbidden: ['H-cheap'], hardCaps: ['chat', 'coding'] });
for (const t of [
  'Use the calculator tool to add 15 and 27',
  'Call the search tool to find the latest release notes',
  'Invoke the weather tool for Shanghai',
  'Run the database tool to fetch users',
  '请调用计算器工具计算 15 加 27',
  '请调用搜索工具查一下这篇文章',
]) add('tool_required_explicit', 'tool_orchestration', { model: 'auto', messages: [{ role: 'user', content: t }], tools: toolDefs }, { acceptable: ['H-tool', 'H-coding95'], forbidden: ['H-chat', 'H-cheap', 'H-reason', 'H-vision95'], hardCaps: ['chat', 'tool_use'] });
for (const t of [
  'What is the weather?',
  'Compute the total please',
  'Find the latest price',
]) add('tool_choice_required', 'tool_orchestration', { model: 'auto', messages: [{ role: 'user', content: t }], tools: toolDefs, tool_choice: 'required' }, { acceptable: ['H-tool', 'H-coding95'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'tool_use'] });
for (const t of [
  'What is the weather?',
  'Hi there',
]) add('tool_choice_auto', 'general_chat', { model: 'auto', messages: [{ role: 'user', content: t }], tools: toolDefs, tool_choice: 'auto' }, { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// ===========================================================================
// D. 协议级结构化输出（第三节）
// ===========================================================================
for (const t of [
  'Extract the names from this list',
  'Summarize the meeting',
  'List all products',
]) add('protocol_response_format', 'structured_output', { model: 'auto', messages: [{ role: 'user', content: t }], response_format: { type: 'json_object' } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap', 'H-tool'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  'Return customer data',
  'Give me the schema result',
]) add('protocol_json_schema', 'structured_output', { model: 'auto', messages: [{ role: 'user', content: t }], response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' } } } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  'Produce a structured summary',
  'Format the answer as data',
]) add('protocol_text_format', 'structured_output', { model: 'auto', input: t, text: { format: 'json_object' } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  'Output a JSON report',
  'Return structured analytics',
]) add('protocol_output_config', 'structured_output', { model: 'auto', messages: [{ role: 'user', content: t }], output_config: { structured: { enabled: true } } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  'Tell me about JSON format',
  'What is a JSON file used for?',
]) add('json_mention_only', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// ===========================================================================
// E. 上下文 / Token 估算（第四节）
// ===========================================================================
add('cjk_long_context', 'summarization', chatBody('总结这份很长的中文报告：' + '这是一个很长的段落用来测试上下文窗口的估算是否准确。'.repeat(1200)), { acceptable: ['H-bigctx', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-smallctx'], hardCaps: ['chat'] });
add('cjk_long_context2', 'analysis', chatBody('分析这份中文数据：' + '数据点表示每日销售额的变化趋势需要详细分析。'.repeat(1500)), { acceptable: ['H-bigctx', 'H-reason', 'H-coding95'], forbidden: ['H-smallctx'], hardCaps: ['chat'] });
const bigSchema = { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(800) }, b: { type: 'integer', description: 'y'.repeat(800) }, c: { type: 'array', items: { type: 'string' }, description: 'z'.repeat(800) } } };
const manyTools = [];
for (let i = 0; i < 12; i++) manyTools.push({ type: 'function', function: { name: 'tool_' + i, parameters: bigSchema } });
add('large_tool_schema', 'general_chat', { model: 'auto', messages: [{ role: 'user', content: 'Please help with this request' }], tools: manyTools }, { acceptable: ['H-bigctx', 'H-reason', 'H-coding95'], forbidden: ['H-smallctx', 'H-cheap'], hardCaps: ['chat'] });
add('multi_turn_tool', 'tool_orchestration', { model: 'auto', messages: [
  { role: 'user', content: 'What is 15 + 27? Use the calculator tool.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"a":15,"b":27}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '{"result":42}' },
  { role: 'user', content: 'Now add 100 to that.' },
], tools: toolDefs }, { acceptable: ['H-tool', 'H-coding95'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'tool_use'] });

// ===========================================================================
// F. 等级能力分（60-99）与模型形态（caps-only / legacy-only）（第一、五节）
// ===========================================================================
for (const t of [
  'How do I make coffee?',
  'Tell me a fun fact about space',
  'What time is it?',
]) add('graded_chat95', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95', 'H-smallctx'], hardCaps: ['chat'] });
for (const t of [
  'Write a function to debounce input',
  'Write a SQL query to join two tables',
  'Fix this off-by-one error in the loop',
  'Implement a binary search',
]) add('graded_coding95', 'coding', chatBody(t), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat', 'H-smallctx'], hardCaps: ['chat', 'coding'] });
for (const t of [
  'Describe this image in detail',
  'What is in this picture?',
]) add('graded_vision95', 'vision', { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }, { type: 'text', text: t }] }] }, { acceptable: ['H-vision95'], forbidden: ['H-chat', 'H-cheap', 'H-coding95'], hardCaps: ['chat', 'vision'] });

// ===========================================================================
// G. Policy 切换（第六节）——按 policyKey 分阶段
// ===========================================================================
for (const t of [
  'Write a poem about the ocean',
  'Tell me a short joke',
  'Recommend a good book',
]) add('policy_prefer_free', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'preferFree' });
for (const t of [
  'Summarize the meeting in three bullets',
  'Summarize this into a quick reply',
  'Give a one-line summary',
]) add('policy_no_prefer_free', 'summarization', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'noPreferFree' });
for (const t of [
  'Hello there',
  'What is 2 + 2?',
  'Nice to meet you',
]) add('policy_no_tier', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'noTier' });

// ===========================================================================
// H. 混合语言 / 歧义 / null 安全（第七节相关）
// ===========================================================================
add('mixed_lang_translate_zh', 'translation', chatBody('帮我把这段 English text 翻译成 Chinese，keep it formal'), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
add('mixed_lang_summary', 'summarization', chatBody('Analyze 这份报告 and summarize the 要点'), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
add('mixed_lang_coding', 'coding', chatBody('用中文解释 Fibonacci 函数的实现逻辑'), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat'], hardCaps: ['chat', 'coding'] });
add('mixed_lang_translate', 'translation', chatBody('请把这句 English 翻译成 中文'), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  'Tell me something interesting',
  'What should I eat for dinner?',
  'Do you like music?',
]) add('ambiguous_chat', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });

// null 安全：strict 未知模型 → 无候选 → recommendation=null
for (const m of ['ghost-holdout-1', 'ghost-holdout-2', 'no-such-model-holdout']) {
  add('null_safe_strict', 'general_chat', { model: m, messages: [{ role: 'user', content: 'hi' }] }, { acceptable: [], forbidden: [], hardCaps: ['chat'], expectOutcome: 'no_candidate', budgetKey: 'strict', nullAllowed: true });
}

// ===========================================================================
// I. Provider 健康 / 预算边界 / no-paid / strict（沿用回归语义，独立措辞）
// ===========================================================================
for (const t of [
  'Explain the solar system',
  'Tell me about volcanoes',
  'Describe a sunset',
]) add('provider_health_holdout', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-tool', 'H-bigctx'], forbidden: ['H-fail', 'H-reason'], hardCaps: ['chat'], healthStage: true });
for (const t of [
  'Analyze this data set in detail',
  'Analyze this complex topic thoroughly',
]) add('budget_boundary', 'analysis', chatBody(t), { acceptable: [], forbidden: ['H-reason'], hardCaps: ['chat'], budgetKey: 'budget', expectNoRecommendation: true, nullAllowed: true });
for (const t of [
  'Write a poem about rain',
  'Explain quantum entanglement simply',
]) add('no_paid_holdout', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-tool', 'H-bigctx', 'H-struct', 'H-nostream'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'], budgetKey: 'nopaid' });
for (const m of ['holdout-missing-a', 'holdout-missing-b']) {
  add('strict_holdout', 'general_chat', { model: m, messages: [{ role: 'user', content: 'hello' }] }, { acceptable: [], forbidden: [], hardCaps: ['chat'], expectOutcome: 'no_candidate', budgetKey: 'strict', nullAllowed: true });
}
for (const t of [
  'Reply with a short greeting',
  'Say something friendly',
]) add('fallback_holdout', 'general_chat', chatBody(t), { acceptable: ['H-fail', 'H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: [], hardCaps: ['chat'], budgetKey: 'fallback', expectOutcome: 'completed' });

// ===========================================================================
// J. 补充：中文编码/调试、同义词调试/研究、更多对抗覆盖（总计 ≥200）
// ===========================================================================
for (const t of [
  '写一个防抖函数',
  '写一个 SQL 查询连接两张表',
  '实现一个二分查找算法',
  '写一个解析 JSON 的 Python 函数',
  '编写一个 React 组件实现待办列表',
  '写一个备份文件的 shell 脚本函数',
]) add('zh_coding', 'coding', chatBody(t), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat', 'H-smallctx'], hardCaps: ['chat', 'coding'] });
for (const t of [
  '修复这个空指针异常',
  '这段代码为什么一运行就崩溃',
  '调试这个死循环问题',
  '这个函数返回的结果不对，帮我排查',
  '程序在登录时闪退，怎么修',
  '数据库连接报错，看看哪里出了问题',
]) add('zh_debugging', 'debugging', chatBody(t), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat', 'H-smallctx'], hardCaps: ['chat', 'coding'] });
for (const t of [
  'This function returns garbage instead of the sum',
  'My program hangs at startup for no reason',
  'The query times out after a few seconds',
  'The program crashes whenever I click the submit button',
  'The loop never seems to terminate',
  'Why does this keep throwing a null error?',
]) add('syn_debugging', 'debugging', chatBody(t), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat'], hardCaps: ['chat', 'coding'] });
for (const t of [
  'Dig into the latest findings on transformer efficiency',
  'Look into recent papers about vector databases',
  'Survey the current state of multimodal LLMs',
  'Investigate best practices for MCP servers',
]) add('syn_research', 'research', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat', 'H-bigctx'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  '查一下大模型推理加速的最新资料',
  '调研一下本地部署 LLM 的行业现状',
  '找找关于 RAG 的文献资料',
  '研究一下向量数据库的选型建议',
]) add('syn_research_zh', 'research', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat', 'H-bigctx'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  'Okay, noted.',
  'That is very helpful, thanks!',
  'Alright, moving on.',
  'Sounds good to me.',
]) add('tools_present_unneeded2', 'general_chat', { model: 'auto', messages: [{ role: 'user', content: t }], tools: readTools }, { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-tool', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'] });
for (const t of [
  'Give me the result in strict JSON',
  'Return an array of items with ids',
]) add('protocol_response_format2', 'structured_output', { model: 'auto', messages: [{ role: 'user', content: t }], response_format: { type: 'json_object' } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap', 'H-tool'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  'Summarize the discussion as a structured object',
  'Output the key metrics as JSON data',
]) add('protocol_text_format2', 'structured_output', { model: 'auto', input: t, text: { format: 'json_schema' } }, { acceptable: ['H-struct', 'H-reason', 'H-coding95', 'H-nostream'], forbidden: ['H-chat', 'H-cheap'], hardCaps: ['chat', 'structured_output'] });
for (const t of [
  '帮我解析这段日志并总结异常',
  '把这份表格整理成摘要返回',
  '分析这个 JSON 中的异常并总结',
]) add('mixed_lang2', 'summarization', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  'Any thoughts?',
  'What is your take on this?',
  'Could you elaborate?',
  'Anything else you would add?',
]) add('ambiguous_chat2', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  'Suggest a movie to watch',
  'Plan my weekend for me',
]) add('policy_prefer_free2', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'preferFree' });
for (const t of [
  'Give me the highlights',
  'Quick summary please',
]) add('policy_no_prefer_free2', 'summarization', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'noPreferFree' });
for (const t of [
  'Good morning',
  'How are you?',
]) add('policy_no_tier2', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason'], hardCaps: ['chat'], policyKey: 'noTier' });
for (const t of [
  'Do you know any good podcasts?',
  'What is your favorite season and why?',
  'Have you tried cooking lately?',
  'What book should everyone read once?',
  'Do you prefer tea or coffee?',
  'What is a hobby you enjoy?',
]) add('no_keyword_chat2', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-bigctx'], forbidden: ['H-reason', 'H-vision95', 'H-smallctx'], hardCaps: ['chat'] });
for (const t of [
  'Prove this number is irrational',
  'Walk through the logic of this deduction problem',
  'Justify the logic behind this reasoning chain',
  'Reason through this causal chain step by step',
]) add('graded_reasoning80', 'analysis', chatBody(t), { acceptable: ['H-reason', 'H-coding95', 'H-chat'], forbidden: ['H-cheap', 'H-vision95'], hardCaps: ['chat'] });
for (const t of [
  'Write a Python script to parse JSON logs',
  'Write a function to compute hashes',
  'Write a regex to match phone numbers',
]) add('caps_only_coding', 'coding', chatBody(t), { acceptable: ['H-coding95', 'H-reason', 'H-nostream'], forbidden: ['H-cheap', 'H-chat'], hardCaps: ['chat', 'coding'] });
for (const t of [
  'Describe this image',
  'What is shown in this photo?',
  'Analyze this chart image',
]) add('legacy_only_vision', 'vision', { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }, { type: 'text', text: t }] }] }, { acceptable: ['H-vision95'], forbidden: ['H-chat', 'H-cheap', 'H-coding95'], hardCaps: ['chat', 'vision'] });
for (const t of [
  'Analyze this financial report carefully',
  'Analyze this dense technical chapter in depth',
]) add('budget_boundary2', 'analysis', chatBody(t), { acceptable: [], forbidden: ['H-reason'], hardCaps: ['chat'], budgetKey: 'budget', expectNoRecommendation: true, nullAllowed: true });
for (const t of [
  'Tell me a story about a dragon',
  'Describe a quiet forest at dawn',
]) add('no_paid_holdout2', 'general_chat', chatBody(t), { acceptable: ['H-chat', 'H-cheap', 'H-coding95', 'H-tool', 'H-bigctx', 'H-struct', 'H-nostream'], forbidden: ['H-reason', 'H-vision95'], hardCaps: ['chat'], budgetKey: 'nopaid' });

export default TASKS;
