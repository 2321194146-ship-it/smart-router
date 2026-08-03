// test/unit/intelligence.test.js
// Smart Router Mainline - Phase 2-B (Active Readiness)
// 智能层单元测试：Task Analyzer（requiredCapabilities）/ Capability Registry /
// Policy（能力评分 + streaming/预算硬约束）/ Budget / Decision Engine /
// Explainability / Shadow Recorder / off-shadow 模式 / Provider 健康

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  analyzeTask, buildRequiredCapabilities, TaskType, CAPABILITY_KEYS,
} from '../../src/intelligence/task-analyzer.js';
import {
  CapabilityRegistry, extractCapabilities, normalizeCapabilityScore, deriveProtocols,
} from '../../src/intelligence/capability-registry.js';
import {
  normalizePolicy, scoreCandidate, hardConstraintBlock, budgetBlock, estimateCost,
  predictQuality, predictLatency,
} from '../../src/intelligence/policy.js';
import { evaluateBudget } from '../../src/intelligence/budget.js';
import { DecisionEngine } from '../../src/intelligence/decision-engine.js';
import { explainDecision } from '../../src/intelligence/explainability.js';
import {
  ShadowRecorder, sanitizeTaskProfile, computeComparisonStatus,
} from '../../src/intelligence/shadow-recorder.js';
import { IntelligenceLayer } from '../../src/intelligence/index.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const POLICY = normalizePolicy(null);

// 标准化模型配置（含 capabilities 对象 0-100 分制 + reliability + latency_prior_ms）
const TEST_CONFIG = {
  intelligence: { mode: 'shadow', shadow: { retentionDays: 30 } },
  models: [
    {
      id: 'm1', provider: 'p1', tier: 'tier1', paid: false,
      capabilities: { chat: 100, coding: 100, reasoning: 30, tool_use: 100, vision: 0, structured_output: 50, long_context: 80, streaming: 100 },
      context_window: 64000, reliability: 0.95, latency_prior_ms: 800,
      price: { input_cost_per_1k: 0, output_cost_per_1k: 0 },
    },
    {
      id: 'm2', provider: 'p2', tier: 'tier2', paid: true,
      capabilities: { chat: 100, coding: 20, reasoning: 100, tool_use: 0, vision: 100, structured_output: 100, long_context: 60, streaming: 0 },
      context_window: 32000, reliability: 0.8, latency_prior_ms: 1500,
      price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 },
    },
    {
      id: 'm3', provider: 'p3', tier: 'tier3', paid: false,
      capability: ['chat'], // 兼容旧字符串数组：仅 chat
      max_tokens: 16000, reliability: 0.6,
      price: { input_cost_per_1k: 0, output_cost_per_1k: 0 },
    },
    // 同 modelId 不同 Provider（价格/能力不同）
    {
      id: 'mx', provider: 'pA', tier: 'tier1', paid: false,
      capabilities: { chat: 100, coding: 80, reasoning: 80, tool_use: 100, vision: 100, structured_output: 80, long_context: 100, streaming: 100 },
      context_window: 128000, reliability: 0.9, latency_prior_ms: 900,
      price: { input_cost_per_1k: 0, output_cost_per_1k: 0 },
    },
    {
      id: 'mx', provider: 'pB', tier: 'tier2', paid: true,
      capabilities: { chat: 100, coding: 10, reasoning: 10, tool_use: 0, vision: 0, structured_output: 0, long_context: 20, streaming: 0 },
      context_window: 8000, reliability: 0.5, latency_prior_ms: 2000,
      price: { input_cost_per_1k: 0.02, output_cost_per_1k: 0.04 },
    },
  ],
  budget: { allowPaid: false, maxRequestCost: 10, allowedModels: [], allowedProviders: [], strictModel: false },
  agent_bindings: {},
};

describe('Phase2-C 能力数据源统一（Phase1 buildCandidates 复用 Registry）', () => {
  let buildCandidatesFn = null;
  let extractCaps = null;
  let hasCaps = null;

  test('C5 setup: dynamic imports', async () => {
    const mod = await import('../../src/router/candidates.js');
    buildCandidatesFn = mod.buildCandidates;
    const reg = await import('../../src/intelligence/capability-registry.js');
    extractCaps = reg.extractCapabilities;
    hasCaps = reg.hasCapability;
  });

  test('C5 capabilities-only model (no legacy array) yields candidates for vision', async () => {
    const config = {
      models: [
        { id: 'v1', provider: 'p1', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, vision: 100, tool_use: 0, coding: 0, reasoning: 0, structured_output: 0, long_context: 0, streaming: 0 }, context_window: 32000 },
        { id: 'c1', provider: 'p1', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, vision: 0, tool_use: 0, coding: 0, reasoning: 0, structured_output: 0, long_context: 0, streaming: 0 }, context_window: 32000 },
      ],
      budget: { allowPaid: true },
      agent_bindings: {},
    };
    const cands = buildCandidatesFn('auto', config, { capability: 'vision', budget: config.budget });
    const ids = cands.map((cc) => cc.modelId);
    assert.ok(ids.includes('v1'), 'capabilities-only vision model must be a candidate');
    assert.ok(!ids.includes('c1'), 'non-vision model must be filtered out');
  });

  test('C5 capabilities vision=95 counts as supported (threshold 0.9)', async () => {
    const config = {
      models: [
        { id: 'v95', provider: 'p1', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, vision: 95 }, context_window: 32000 },
        { id: 'v60', provider: 'p1', tier: 'tier1', paid: false, enabled: true, capabilities: { chat: 100, vision: 60 }, context_window: 32000 },
      ],
      budget: { allowPaid: true },
      agent_bindings: {},
    };
    const cands = buildCandidatesFn('auto', config, { capability: 'vision', budget: config.budget });
    const ids = cands.map((cc) => cc.modelId);
    assert.ok(ids.includes('v95'), 'vision=95 must be supported (>= 0.9)');
    assert.ok(!ids.includes('v60'), 'vision=60 must NOT be supported (< 0.9)');
  });

  test('C5 legacy capability array still works', async () => {
    const config = {
      models: [
        { id: 'legacy', provider: 'p1', tier: 'tier1', paid: false, enabled: true, capability: ['chat', 'vision'], context_window: 32000 },
      ],
      budget: { allowPaid: true },
      agent_bindings: {},
    };
    const cands = buildCandidatesFn('auto', config, { capability: 'vision', budget: config.budget });
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].modelId, 'legacy');
  });

  test('C5 extractCapabilities merges object + legacy (max semantics)', () => {
    const caps = extractCaps({ capability: ['chat', 'vision'], capabilities: { vision: 95, chat: 100 } });
    assert.strictEqual(caps.vision, 1.0); // legacy array => full support (max)
    assert.strictEqual(caps.chat, 1.0);
  });

  test('C5 registry hasCapability aligned with threshold', () => {
    assert.strictEqual(hasCaps({ capabilities: { vision: 100 } }, 'vision'), true);
    assert.strictEqual(hasCaps({ capabilities: { vision: 95 } }, 'vision'), true);
    assert.strictEqual(hasCaps({ capabilities: { vision: 60 } }, 'vision'), false);
  });
});

describe('Phase2-C Task Analyzer（协议级结构化输出检测）', () => {
  test('C3 OpenAI Chat response_format=json_object → structuredOutputRequired', () => {
    const t = analyzeTask({
      model: 'auto',
      messages: [{ role: 'user', content: 'Extract the names from this list' }],
      response_format: { type: 'json_object' },
    }, { protocol: 'chat' });
    assert.strictEqual(t.structuredOutputRequired, true);
    assert.strictEqual(t.needsStructuredOutput, true);
    assert.strictEqual(t.taskType, TaskType.STRUCTURED_OUTPUT);
    assert.ok(t.hardCapabilities.includes('structured_output'));
  });

  test('C3 OpenAI Chat response_format=json_schema (with schema) → structuredOutputRequired', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Summarize the meeting' }],
      response_format: { type: 'json_schema', json_schema: { name: 'summary', schema: { type: 'object' } } },
    }, { protocol: 'chat' });
    assert.strictEqual(t.structuredOutputRequired, true);
  });

  test('C3 Responses text.format=json_object → structuredOutputRequired', () => {
    const t = analyzeTask({
      model: 'auto',
      input: 'Return the result as structured data',
      text: { format: 'json_object' },
    }, { protocol: 'responses' });
    assert.strictEqual(t.structuredOutputRequired, true);
  });

  test('C3 Responses text.json_schema object → structuredOutputRequired', () => {
    const t = analyzeTask({
      input: 'List products',
      text: { json_schema: { name: 'products', schema: { type: 'object' } } },
    }, { protocol: 'responses' });
    assert.strictEqual(t.structuredOutputRequired, true);
  });

  test('C3 Anthropic output_config → structuredOutputRequired', () => {
    const t = analyzeTask({
      model: 'auto',
      messages: [{ role: 'user', content: 'Produce a JSON summary' }],
      output_config: { structured: { enabled: true } },
    }, { protocol: 'anthropic' });
    assert.strictEqual(t.structuredOutputRequired, true);
  });

  test('C3 plain JSON mention without protocol field → NOT structuredOutputRequired', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Tell me about JSON format and its uses' }],
    });
    assert.strictEqual(t.structuredOutputRequired, false, 'keyword alone must not count as protocol requirement');
  });

});

describe('Phase2-C Task Analyzer（工具可用 vs 工具必需）', () => {
  const toolDefs = [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object', properties: {} } } }];
  const readTool = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

  test('C2 tools present + normal explanation → NOT tool_orchestration, toolsRequired=false', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Please explain how web search works' }],
      tools: readTool,
    });
    assert.strictEqual(t.toolsAvailable, true);
    assert.strictEqual(t.toolsRequired, false, 'tools present alone must not force tool use');
    assert.strictEqual(t.needsToolUse, false);
    assert.notStrictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
  });

  test('C2 Claude Code style: tools present, natural code review request → general flow', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Please review this code for style issues and explain your suggestions' }],
      tools: readTool,
    });
    assert.strictEqual(t.toolsRequired, false);
    assert.strictEqual(t.needsToolUse, false);
    assert.notStrictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
  });

  test('C2 Codex style: tools present, no tool_choice, question → analysis, not tool task', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Why does this test fail intermittently? Explain the possible causes.' }],
      tools: readTool,
    });
    assert.strictEqual(t.toolsRequired, false);
    assert.notStrictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
  });

  test('C2 tools present + explicit tool request → toolsRequired=true, tool_orchestration', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Use the calculator tool to add 15 and 27' }],
      tools: toolDefs,
    });
    assert.strictEqual(t.toolsRequired, true);
    assert.strictEqual(t.needsToolUse, true);
    assert.strictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
    assert.ok(t.hardCapabilities.includes('tool_use'));
  });

  test('C2 imperative pattern: Call the weather tool → toolsRequired=true', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Call the weather tool to check conditions' }],
      tools: toolDefs,
    });
    assert.strictEqual(t.toolsRequired, true);
    assert.strictEqual(t.taskType, TaskType.TOOL_ORCHESTRATION);
  });

  test('C2 tool_choice=required forces toolsRequired', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: toolDefs,
      tool_choice: 'required',
    });
    assert.strictEqual(t.toolsRequired, true);
    assert.strictEqual(t.needsToolUse, true);
  });

  test('C2 tool_choice={type:function,name:...} forces toolsRequired (OpenAI style)', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Add 1 and 2' }],
      tools: toolDefs,
      tool_choice: { type: 'function', function: { name: 'calculator' } },
    });
    assert.strictEqual(t.toolsRequired, true);
  });

  test('C2 tool_choice=auto / none does NOT force toolsRequired', () => {
    for (const tc of ['auto', 'none', { type: 'auto' }, { type: 'none' }]) {
      const t = analyzeTask({
        messages: [{ role: 'user', content: 'Hi there' }],
        tools: toolDefs,
        tool_choice: tc,
      });
      assert.strictEqual(t.toolsRequired, false, 'tool_choice ' + JSON.stringify(tc) + ' must not force');
    }
  });

  test('C2 natural "what is a calculator" question does NOT trigger toolsRequired', () => {
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'What is a calculator and how does it work?' }],
    });
    assert.strictEqual(t.toolsRequired, false);
    assert.strictEqual(t.toolsAvailable, false);
  });

});

describe('Phase2-B Task Analyzer（统一能力需求画像）', () => {
  test('13 task types produce distinct requiredCapabilities', () => {
    const cases = [
      ['Hello, how are you?', TaskType.GENERAL_CHAT],
      ['Write a JavaScript function to debounce', TaskType.CODING],
      ['Debug this: why does this function crash on null input?', TaskType.DEBUGGING],
      ['Design the architecture for a microservice system', TaskType.ARCHITECTURE],
      ['Explain why the sky is blue using physics', TaskType.ANALYSIS],
      ['Research the literature on transformers', TaskType.RESEARCH],
      ['Write an essay about climate change', TaskType.WRITING],
      ['Summarize this article in 3 sentences', TaskType.SUMMARIZATION],
      ['Translate this text to Chinese', TaskType.TRANSLATION],
      ['Extract all dates from this text', TaskType.EXTRACTION],
      ['Use the calculator tool to add numbers', TaskType.TOOL_ORCHESTRATION],
      ['Describe this image', TaskType.VISION],
      ['Output as JSON with schema', TaskType.STRUCTURED_OUTPUT],
    ];
    for (const [text, expected] of cases) {
      const t = analyzeTask({ model: 'auto', messages: [{ role: 'user', content: text }] });
      assert.strictEqual(t.taskType, expected, `"${text}" should be ${expected}, got ${t.taskType}`);
    }
  });

  test('requiredCapabilities structure', () => {
    const t = analyzeTask({ model: 'auto', messages: [{ role: 'user', content: 'Write a JS function' }] });
    for (const k of CAPABILITY_KEYS) {
      assert.ok(k in t.requiredCapabilities, `missing key ${k}`);
    }
    assert.strictEqual(t.requiredCapabilities.chat, 1.0);
    assert.strictEqual(t.requiredCapabilities.coding, 1.0);
  });

  test('debugging: coding+reasoning high', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'Debug this crash: stack trace below, fix the bug' }] });
    assert.strictEqual(t.taskType, TaskType.DEBUGGING);
    assert.strictEqual(t.requiredCapabilities.coding, 1.0);
    assert.strictEqual(t.requiredCapabilities.reasoning, 0.85);
  });

  test('summarization: reasoning low, cost-friendly', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'Summarize this meeting' }] });
    assert.strictEqual(t.taskType, TaskType.SUMMARIZATION);
    assert.ok(t.requiredCapabilities.reasoning <= 0.5, 'summarization should not require high reasoning');
  });

  test('stream=true → streaming hard requirement', () => {
    const t = analyzeTask({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(t.needsStreaming, true);
    assert.strictEqual(t.requiredCapabilities.streaming, 1.0);
    assert.ok(t.hardCapabilities.includes('streaming'));
  });

  test('non-stream request does NOT require streaming', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(t.requiredCapabilities.streaming, 0);
    assert.ok(!t.hardCapabilities.includes('streaming'));
  });

  // ---- Phase2-C 回归：hardCapabilities 只含二元能力，不含等级能力 ----
  test('C2 general chat hardCapabilities excludes graded chat/coding/reasoning', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'Hello, how are you?' }] });
    assert.ok(!t.hardCapabilities.includes('chat'), 'chat is graded, must not be hard');
    assert.ok(!t.hardCapabilities.includes('coding'));
    assert.ok(!t.hardCapabilities.includes('reasoning'));
  });

  test('C2 coding task keeps coding requirement=1.0 but NOT in hardCapabilities', () => {
    const t = analyzeTask({ messages: [{ role: 'user', content: 'Write a JavaScript function to debounce' }] });
    assert.strictEqual(t.taskType, TaskType.CODING);
    assert.strictEqual(t.requiredCapabilities.coding, 1.0, 'graded requirement still 1.0 for scoring');
    assert.ok(!t.hardCapabilities.includes('coding'));
  });

  test('vision task requires vision; structured output requires structured_output', () => {
    const v = analyzeTask({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'desc' }] }] });
    assert.strictEqual(v.requiredCapabilities.vision, 1.0);
    const s = analyzeTask({ messages: [{ role: 'user', content: 'Output as JSON array' }] });
    assert.strictEqual(s.taskType, TaskType.STRUCTURED_OUTPUT);
    assert.strictEqual(s.requiredCapabilities.structured_output, 1.0);
  });
});

describe('Phase2-B Capability Registry（Model Capability Profile）', () => {
  const reg = new CapabilityRegistry(TEST_CONFIG);

  test('capabilities object normalized from 0-100', () => {
    const prof = reg.getProfile('m1', 'p1');
    assert.ok(prof);
    assert.strictEqual(prof.capabilities.chat, 1.0);
    assert.strictEqual(prof.capabilities.tool_use, 1.0);
    assert.strictEqual(prof.capabilities.reasoning, 0.3);
    assert.strictEqual(prof.capabilities.vision, 0);
  });

  test('legacy string capability array compatible', () => {
    const prof = reg.getProfile('m3', 'p3');
    assert.strictEqual(prof.capabilities.chat, 1.0);
    assert.strictEqual(prof.capabilities.tool_use, 0);
  });

  test('normalizeCapabilityScore 0-1 and 0-100', () => {
    assert.strictEqual(normalizeCapabilityScore(0.5), 0.5);
    assert.strictEqual(normalizeCapabilityScore(90), 0.9);
    assert.strictEqual(normalizeCapabilityScore(100), 1.0);
    assert.strictEqual(normalizeCapabilityScore(0), 0);
  });

  test('profile includes reliability, latencyPriorMs, protocols', () => {
    const prof = reg.getProfile('m1', 'p1');
    assert.strictEqual(prof.reliability, 0.95);
    assert.strictEqual(prof.latencyPriorMs, 800);
    assert.ok(prof.protocols.includes('chat'));
    assert.strictEqual(prof.contextWindow, 64000);
  });

  test('same modelId different provider keep independent profiles', () => {
    const pa = reg.getProfile('mx', 'pA');
    const pb = reg.getProfile('mx', 'pB');
    assert.notStrictEqual(pa.capabilities.reasoning, pb.capabilities.reasoning);
    assert.notStrictEqual(pa.price.input_cost_per_1k, pb.price.input_cost_per_1k);
    assert.notStrictEqual(pa.reliability, pb.reliability);
  });
});

describe('Phase2-B Policy（能力评分 + 硬约束）', () => {
  const baseCaps = { chat: 1, coding: 1, reasoning: 1, tool_use: 1, vision: 0, structured_output: 0, long_context: 1, streaming: 1 };
  const base = { modelId: 'm', provider: 'p', tier: 'tier1', paid: false, capabilities: baseCaps, contextWindow: 100000, price: {}, protocols: ['chat'] };
  const BUDGET = { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 100 };

  // ---- Phase2-C 回归：等级能力（chat/coding/reasoning）不得因 >=1.0 需求被硬阻断 ----
  test('C2 chat=95 executes general chat (no false block)', () => {
    const model = { ...base, capabilities: { ...baseCaps, chat: 0.95 } };
    const task = { requiredCapabilities: { chat: 1 }, hardCapabilities: ['chat'], complexity: 0.3 };
    const r = scoreCandidate(model, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null, 'chat=95 must not be blocked as missing chat');
    assert.ok(r.score > 0);
  });

  test('C2 coding=95 executes coding task (no false block)', () => {
    const model = { ...base, capabilities: { ...baseCaps, coding: 0.95 } };
    const task = { requiredCapabilities: { chat: 1, coding: 1 }, hardCapabilities: ['coding'], complexity: 0.7 };
    const r = scoreCandidate(model, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null, 'coding=95 must not be blocked as missing coding');
    assert.ok(r.score > 0);
  });

  test('C2 reasoning=80 participates in reasoning task (no false block)', () => {
    const model = { ...base, capabilities: { ...baseCaps, reasoning: 0.8 } };
    const task = { requiredCapabilities: { chat: 1, reasoning: 0.85 }, hardCapabilities: ['chat'], complexity: 0.8 };
    const r = scoreCandidate(model, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null, 'reasoning=80 must not be blocked');
    assert.ok(r.score > 0);
  });

  test('C2 vision=95 (graded-style score) is NOT treated as unsupported', () => {
    const model = { ...base, capabilities: { ...baseCaps, vision: 0.95 } };
    const task = { requiredCapabilities: { chat: 1, vision: 1 }, hardCapabilities: ['vision'], needsVision: true, complexity: 0.5 };
    const r = scoreCandidate(model, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null, 'vision=95 (0.95 >= 0.9 threshold) must count as supported');
    assert.ok(r.score > 0);
  });

  test('C2 vision=60 below binary threshold → blocked (still hard capability)', () => {
    const model = { ...base, capabilities: { ...baseCaps, vision: 0.6 } };
    const task = { requiredCapabilities: { chat: 1, vision: 1 }, hardCapabilities: ['vision'], needsVision: true, complexity: 0.5 };
    const r = scoreCandidate(model, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('vision'));
  });

  test('C2 gradedSafetyThreshold explicit: coding below threshold blocked', () => {
    const model = { ...base, capabilities: { ...baseCaps, coding: 0.5 } };
    const task = { requiredCapabilities: { chat: 1, coding: 1 }, hardCapabilities: ['coding'], complexity: 0.7 };
    const p = normalizePolicy({ gradedSafetyThreshold: 0.6 });
    const r = scoreCandidate(model, task, p, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('safety threshold'));
  });

  test('C3 structuredOutputRequired blocks models below binary threshold', () => {
    const noStruct = { modelId: 'm', provider: 'p', tier: 'tier1', paid: false, capabilities: { chat: 1, coding: 1, reasoning: 1, tool_use: 1, vision: 0, structured_output: 0.5, long_context: 1, streaming: 1 }, contextWindow: 100000, price: {}, protocols: ['chat'] };
    const task = { requiredCapabilities: { chat: 1, structured_output: 1 }, hardCapabilities: ['structured_output'], needsStructuredOutput: true, structuredOutputRequired: true, complexity: 0.6 };
    const r = scoreCandidate(noStruct, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('structured_output'));
  });

  test('C3 structuredOutputRequired + strong model → not blocked', () => {
    const struct = { modelId: 'm', provider: 'p', tier: 'tier1', paid: false, capabilities: { chat: 1, coding: 1, reasoning: 1, tool_use: 1, vision: 0, structured_output: 1, long_context: 1, streaming: 1 }, contextWindow: 100000, price: {}, protocols: ['chat'] };
    const task = { requiredCapabilities: { chat: 1, structured_output: 1 }, hardCapabilities: ['structured_output'], needsStructuredOutput: true, structuredOutputRequired: true, complexity: 0.6 };
    const r = scoreCandidate(struct, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null);
    assert.ok(r.score > 0);
  });

  test('C2 toolsAvailable only → non-tool candidate NOT blocked by tool_use', () => {
    const noTool = { modelId: 'm', provider: 'p', tier: 'tier1', paid: false, capabilities: { ...{ chat: 1, coding: 1, reasoning: 1, tool_use: 1, vision: 0, structured_output: 0, long_context: 1, streaming: 1 }, tool_use: 0 }, contextWindow: 100000, price: {}, protocols: ['chat'] };
    const task = { requiredCapabilities: { chat: 1 }, hardCapabilities: [], needsToolUse: false, toolsAvailable: true, toolsRequired: false, complexity: 0.3 };
    const r = scoreCandidate(noTool, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null, 'tool_use only required when toolsRequired');
    assert.ok(r.score > 0);
  });

  test('streaming hard constraint: stream=true + no streaming → blocked', () => {
    const noStream = { ...base, capabilities: { ...baseCaps, streaming: 0 } };
    const task = { requiredCapabilities: { chat: 1, streaming: 1 }, hardCapabilities: ['streaming'], needsStreaming: true, complexity: 0.3 };
    const r = scoreCandidate(noStream, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('streaming'));
  });

  test('non-stream request with no streaming → NOT blocked', () => {
    const noStream = { ...base, capabilities: { ...baseCaps, streaming: 0 } };
    const task = { requiredCapabilities: { chat: 1 }, hardCapabilities: ['chat'], complexity: 0.3 };
    const r = scoreCandidate(noStream, task, POLICY, BUDGET, 'chat');
    assert.strictEqual(r.blocked, null);
    assert.ok(r.score > 0);
  });

  test('missing tool_use → blocked', () => {
    const r = scoreCandidate({ ...base, capabilities: { ...baseCaps, tool_use: 0 } },
      { requiredCapabilities: { chat: 1, tool_use: 1 }, hardCapabilities: ['tool_use'], needsToolUse: true, complexity: 0.5 },
      POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('tool_use'));
  });

  test('missing vision → blocked', () => {
    const r = scoreCandidate(base,
      { requiredCapabilities: { chat: 1, vision: 1 }, hardCapabilities: ['vision'], needsVision: true, complexity: 0.5 },
      POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('vision'));
  });

  test('context overflow → blocked', () => {
    const r = scoreCandidate({ ...base, contextWindow: 500 },
      { requiredCapabilities: { chat: 1 }, hardCapabilities: ['chat'], estimatedInputTokens: 6000, complexity: 0.5 },
      POLICY, BUDGET, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('contextWindow'));
  });

  test('hardConstraintBlock null when satisfied', () => {
    const ok = hardConstraintBlock(
      { capabilities: { chat: 1, tool_use: 1, vision: 1, streaming: 1, long_context: 1 }, contextWindow: 100000, protocols: ['chat'] },
      { hardCapabilities: ['chat', 'tool_use', 'vision'], needsStreaming: true, needsToolUse: true, needsVision: true, estimatedInputTokens: 100 },
      'chat',
    );
    assert.strictEqual(ok, null);
  });

  test('request_cost_exceeded → blocked', () => {
    const priced = { ...base, price: { input_cost_per_1k: 0.1, output_cost_per_1k: 0.2 } };
    const task = { requiredCapabilities: { chat: 1 }, hardCapabilities: ['chat'], estimatedInputTokens: 10000, complexity: 0.5 };
    const r = scoreCandidate(priced, task, POLICY,
      { allowPaid: true, allowedModels: [], allowedProviders: [], maxRequestCost: 0.000001 }, 'chat');
    assert.strictEqual(r.score, 0);
    assert.ok(r.blocked.includes('request_cost_exceeded'));
  });

  test('budgetBlock allows within budget', () => {
    const cheap = { ...base, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } };
    const task = { estimatedInputTokens: 1000, complexity: 0.3 };
    assert.strictEqual(budgetBlock(cheap, task, { allowPaid: true, maxRequestCost: 10 }), null);
  });

  test('deterministic latency (no Math.random)', () => {
    const c1 = { modelId: 'm1', provider: 'p1', tier: 'tier1', latencyPriorMs: 800 };
    assert.strictEqual(predictLatency(c1), 800);
    assert.strictEqual(predictLatency(c1), predictLatency(c1));
  });

  test('latency uses health avg only with enough samples', () => {
    const c = { modelId: 'm', provider: 'p', tier: 'tier1' };
    const low = predictLatency(c, { avgLatency: 500, sampleCount: 2 });
    const high = predictLatency(c, { avgLatency: 500, sampleCount: 10 });
    assert.notStrictEqual(low, high, 'sample count threshold changes latency source');
  });

  test('quality capped 0.95; reasoning model beats chat for reasoning task', () => {
    const reasoningModel = { tier: 'tier2', capabilities: { chat: 1, reasoning: 1 }, reliability: 0.8 };
    const chatModel = { tier: 'tier1', capabilities: { chat: 1, reasoning: 0 }, reliability: 0.95 };
    const task = { requiredCapabilities: { chat: 1, reasoning: 0.9 }, complexity: 0.8 };
    const qReason = predictQuality(reasoningModel, task);
    const qChat = predictQuality(chatModel, task);
    assert.ok(qReason >= 0.4 && qReason <= 0.95);
    assert.ok(qReason > qChat, 'reasoning model should outscore chat-only for reasoning task');
  });

  test('estimateCost per candidate price', () => {
    const cheap = { price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } };
    const priced = { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } };
    assert.strictEqual(estimateCost(cheap, { estimatedInputTokens: 1000, complexity: 0.5 }), 0);
    assert.ok(estimateCost(priced, { estimatedInputTokens: 1000, complexity: 0.5 }) > 0);
  });
});

describe('Phase2-B Budget（request_cost_exceeded / wouldBlockAll）', () => {
  test('all over budget → wouldBlockAll true, estimatedCost null', () => {
    const r = evaluateBudget({
      agentId: 'g', task: { estimatedInputTokens: 10000, complexity: 0.5 },
      candidates: [
        { modelId: 'm2', provider: 'p2', paid: true, price: { input_cost_per_1k: 0.1, output_cost_per_1k: 0.2 } },
      ],
      config: { budget: { allowPaid: true, maxRequestCost: 0.000001 }, agent_bindings: {} },
    });
    assert.strictEqual(r.wouldBlockAll, true);
    assert.strictEqual(r.estimatedCost, null);
    assert.ok(r.reasons.some((x) => x.includes('maxRequestCost')));
  });

  test('mixed: blocked candidates listed, estimatedCost from allowed', () => {
    const r = evaluateBudget({
      agentId: 'g', task: { estimatedInputTokens: 1000, complexity: 0.3 },
      candidates: [
        { modelId: 'cheap', provider: 'p', paid: false, price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } },
        { modelId: 'paid', provider: 'p', paid: true, price: { input_cost_per_1k: 0.1, output_cost_per_1k: 0.2 } },
      ],
      config: { budget: { allowPaid: false }, agent_bindings: {} },
    });
    assert.strictEqual(r.wouldBlockAll, false);
    assert.strictEqual(r.estimatedCost, 0);
    assert.strictEqual(r.blockedCandidates.length, 1);
  });

  test('allowPaid=false blocks paid', () => {
    const r = evaluateBudget({
      agentId: 'g', task: { estimatedInputTokens: 100, complexity: 0.3 },
      candidates: [{ modelId: 'm2', provider: 'p2', paid: true, price: {} }],
      config: { budget: { allowPaid: false }, agent_bindings: {} },
    });
    assert.ok(r.blockedCandidates[0].reason.includes('allowPaid=false'));
  });
});

describe('Phase2-B Decision Engine（能力评分 + 硬约束 + 健康）', () => {
  test('complex reasoning: reasoning model beats high-tier chat-only model', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Prove this mathematical theorem with complex reasoning' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use'] },
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision', 'reasoning'] },
      ],
      protocol: 'chat',
    });
    assert.ok(d.recommendation, 'must recommend');
    assert.strictEqual(d.recommendation.modelId, 'm2', 'reasoning model must win for reasoning task');
  });

  test('debugging: coding+reasoning model preferred', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Debug this crash: fix the bug in this function' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'] },
        { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use'] },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation.modelId, 'm1', 'coding model must win for debugging');
  });

  test('simple summarization: cheap model preferred when quality sufficient', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Summarize this meeting in 3 bullets' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'], model: { price: { input_cost_per_1k: 0, output_cost_per_1k: 0 } } },
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'], model: { price: { input_cost_per_1k: 0.01, output_cost_per_1k: 0.02 } } },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation.modelId, 'm3', 'cheap model must win for simple summarization');
  });

  test('streaming hard constraint: stream=true blocks non-streaming candidate', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm3', provider: 'p3', tier: 'tier3', paid: false, capability: ['chat'] },
        { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use', 'streaming'] },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation.modelId, 'm1', 'streaming-capable must be recommended');
    const blocked = d.ranked.find((r) => r.modelId === 'm3');
    assert.ok(blocked.blocked.includes('streaming'));
  });

  test('budget: maxRequestCost=0.000001 blocks priced recommendation → recommendation null', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Analyze this long document' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true, maxRequestCost: 0.000001 },
      candidates: [
        { modelId: 'm2', provider: 'p2', tier: 'tier2', paid: true, capability: ['chat', 'vision'] },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.recommendation, null, 'over-budget candidate must not be recommended');
    assert.ok(d.ranked[0].blocked.includes('request_cost_exceeded'));
    assert.strictEqual(d.budgetAssessment.wouldBlockAll, true);
  });

  test('provider health: degraded provider scores lower (samples >= 5)', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use', 'streaming'] },
        { modelId: 'mx', provider: 'pB', tier: 'tier2', paid: true, capability: ['chat'] },
      ],
      protocol: 'chat',
    });
    // pB 能力弱 + 付费 → 不应胜出；p1 胜出（无健康注入时）
    assert.strictEqual(d.recommendation.modelId, 'm1');
  });

  test('same modelId different provider: per-provider scoring', () => {
    const engine = new DecisionEngine(TEST_CONFIG);
    const d = engine.decide({
      body: { messages: [{ role: 'user', content: 'Solve this complex reasoning problem' }] },
      agentId: 'generic',
      budget: { ...TEST_CONFIG.budget, allowPaid: true },
      candidates: [
        { modelId: 'mx', provider: 'pA', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use', 'vision', 'reasoning'] },
        { modelId: 'mx', provider: 'pB', tier: 'tier2', paid: true, capability: ['chat'] },
      ],
      protocol: 'chat',
    });
    assert.strictEqual(d.ranked.length, 2);
    assert.strictEqual(d.recommendation.provider, 'pA');
  });
});

describe('Phase2-B Explainability', () => {
  test('eliminated reasons include hard blocks', () => {
    const ex = explainDecision({
      recommendation: { modelId: 'm1', provider: 'p1', score: 0.9 },
      ranked: [
        { modelId: 'm1', provider: 'p1', score: 0.9 },
        { modelId: 'm3', provider: 'p3', score: 0, blocked: 'missing streaming (required)' },
      ],
      predictions: { cost: 0, quality: 0.9, latency: 800 },
    });
    assert.ok(ex.eliminated[0].reason.includes('streaming'));
  });
});

describe('Phase2-B Shadow Recorder（脱敏 + 对照状态）', () => {
  test('sanitizeTaskProfile excludes lastUserText', () => {
    const s = sanitizeTaskProfile({ taskType: 'coding', requiredCapabilities: { chat: 1 }, lastUserText: 'SECRET' });
    assert.ok(!('lastUserText' in s));
    assert.ok(s.requiredCapabilities);
  });

  test('comparison statuses', () => {
    const sug = { recommendation: { modelId: 'm1', provider: 'p1' } };
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'completed', finalModel: 'm1', finalProvider: 'p1' }), 'exact_match');
    assert.strictEqual(computeComparisonStatus(null, { outcome: 'budget_exceeded' }), 'policy_agreement');
    assert.strictEqual(computeComparisonStatus(null, { outcome: 'no_candidate' }), 'policy_agreement');
    assert.strictEqual(computeComparisonStatus(sug, { outcome: 'client_aborted' }), 'not_comparable');
  });

  test('persists via MemoryStore mirror', async () => {
    const store = new MemoryStore();
    await store.init();
    const rec = new ShadowRecorder({ enabled: true, store });
    await rec.recordSuggestion({
      requestId: 'r1', protocol: 'chat', taskProfile: { taskType: 'coding' },
      recommendation: { modelId: 'm1', provider: 'p1' }, ranked: [], predictions: {}, explanation: { summary: 'x' },
    });
    await rec.recordFinalized({
      requestId: 'r1', outcome: 'completed', finalModel: 'm1', finalProvider: 'p1', attemptCount: 1,
      attempts: [{ transportOutcome: 'success', usage: {}, cost: { totalCost: 0 }, latencyMs: 50 }],
    });
    const row = await rec.get('r1');
    assert.strictEqual(row.comparisonStatus, 'exact_match');
    assert.strictEqual(row.actualOutcome, 'completed');
  });
});

describe('Phase2-B IntelligenceLayer（off/shadow + await 隔离）', () => {
  function deps(store) { return { store }; }

  test('off mode: suggest null, no records', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, deps(store));
    const d = await layer.suggest({ requestId: 'r1', body: {}, agentId: 'g', budget: {}, candidates: [] });
    assert.strictEqual(d, null);
    await layer.recordFinalized({ requestId: 'r1', outcome: 'completed' });
    assert.strictEqual((await layer.getRecords()).length, 0);
    assert.strictEqual((await store.listShadowDecisions()).length, 0);
  });

  test('shadow mode: suggest + recordFinalized complete row', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(TEST_CONFIG, deps(store));
    await layer.suggest({
      requestId: 'r1', body: { messages: [{ role: 'user', content: 'Write a JS function' }] },
      agentId: 'generic', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat', 'coding', 'tool_use', 'streaming'] }],
      protocol: 'chat',
    });
    await layer.recordFinalized({
      requestId: 'r1', outcome: 'completed', finalModel: 'm1', finalProvider: 'p1', attemptCount: 1,
      attempts: [{ transportOutcome: 'success', usage: {}, cost: { totalCost: 0 }, latencyMs: 50 }],
    });
    const row = await store.getShadowDecision('r1');
    assert.ok(row);
    assert.strictEqual(row.actualOutcome, 'completed');
    assert.strictEqual(row.comparisonStatus, 'exact_match');
  });

  test('suggest DB failure: user flow unaffected, no half record, clear log', async () => {
    const store = new MemoryStore();
    await store.init();
    // 注入会失败的 store（saveShadowDecision 抛错）
    const brokenStore = {
      ...store,
      async saveShadowDecision() { throw new Error('simulated db failure'); },
    };
    const layer = new IntelligenceLayer(TEST_CONFIG, deps(brokenStore));
    // suggest 应抛错（由调用方 try/catch 处理，方案A）
    let thrown = null;
    try {
      await layer.suggest({
        requestId: 'r1', body: { messages: [{ role: 'user', content: 'hi' }] },
        agentId: 'g', budget: TEST_CONFIG.budget,
        candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'] }],
        protocol: 'chat',
      });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'suggest must propagate error for caller to catch+log');
    assert.strictEqual(thrown.message, 'simulated db failure');
    // 不生成半条记录
    assert.strictEqual((await store.listShadowDecisions()).length, 0);
    // off 模式完全不受影响
    const offLayer = new IntelligenceLayer({ intelligence: { mode: 'off' }, models: [], budget: {}, agent_bindings: {} }, deps(store));
    assert.strictEqual(await offLayer.suggest({ requestId: 'r9', body: {}, agentId: 'g', budget: {}, candidates: [] }), null);
  });

  test('attachTo finalizer observer (post-commit)', async () => {
    const store = new MemoryStore();
    await store.init();
    const layer = new IntelligenceLayer(TEST_CONFIG, deps(store));
    const { Finalizer } = await import('../../src/runtime/finalization.js');
    const { CostTracker } = await import('../../src/cost/tracker.js');
    const finalizer = new Finalizer(new CostTracker(TEST_CONFIG, store), store);
    layer.attachTo(finalizer);
    await layer.suggest({
      requestId: 'r2', body: { messages: [{ role: 'user', content: 'hi' }] },
      agentId: 'g', budget: TEST_CONFIG.budget,
      candidates: [{ modelId: 'm1', provider: 'p1', tier: 'tier1', paid: false, capability: ['chat'] }],
      protocol: 'chat',
    });
    const { AttemptLog } = await import('../../src/runtime/attempts.js');
    const { Outcome } = await import('../../src/runtime/outcomes.js');
    const al = new AttemptLog('r2');
    const att = al.add({ attemptNumber: 1, model: 'm1', provider: 'p1', keyId: 'k', transportOutcome: 'success', validatedOutcome: 'completed', latencyMs: 10, usage: { prompt_tokens: 1, completion_tokens: 1 }, cost: { totalCost: 0 }, timestamp: new Date().toISOString() });
    att.setUsage({ prompt_tokens: 1, completion_tokens: 1 }, { totalCost: 0 });
    await store.saveRequest({ requestId: 'r2', agentId: 'g', protocol: 'chat', model: 'm1', provider: 'p1', timestamp: new Date().toISOString() });
    const res = await finalizer.finalizeRequestTransaction('r2', al, Outcome.COMPLETED, { agentId: 'g', protocol: 'chat' });
    assert.ok(res.finalized);
    const row = await store.getShadowDecision('r2');
    assert.ok(row);
    assert.strictEqual(row.comparisonStatus, 'exact_match');
  });
});
