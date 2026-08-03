// test/unit/token-estimator.test.js
// Smart Router Mainline - Phase 2-C
// Token 估算器单元测试：确定性、保守、协议感知。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  estimateTokens, estimateTextTokens, estimateJsonTokens,
} from '../../src/intelligence/token-estimator.js';
import { analyzeTask } from '../../src/intelligence/task-analyzer.js';
import { hardConstraintBlock } from '../../src/intelligence/policy.js';

describe('Phase2-C Token 估算器（确定性保守）', () => {
  test('C4 CJK: 1.3 万中文字符不得只估 3715', () => {
    const text = '这是一段很长的中文文本。'.repeat(1100); // ~1.3 万字
    const est = estimateTextTokens(text);
    assert.ok(est > 9000, `CJK estimate ${est} must far exceed the old 3715`);
    assert.ok(est <= text.length * 2, 'CJK at most ~2 tokens/char');
  });

  test('C4 deterministic: same input same estimate', () => {
    const body = { messages: [{ role: 'user', content: 'Hello world, this is a test message.' }] };
    const a = estimateTokens(body);
    const b = estimateTokens(body);
    assert.deepStrictEqual(a, b);
  });

  test('C4 multi-round tool_result counted into input', () => {
    const body = {
      messages: [
        { role: 'user', content: 'What is 15 + 27? Use the calculator tool.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"a":15,"b":27}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"result":42}' },
        { role: 'user', content: 'Now add 100.' },
      ],
    };
    const plain = estimateTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const withTools = estimateTokens(body);
    assert.ok(withTools.input > plain.input + 30, 'tool_call + tool_result overhead must be counted');
  });

  test('C4 large tool schema triggers long_context', () => {
    const bigSchema = {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'x'.repeat(800) },
        field2: { type: 'integer', description: 'y'.repeat(800) },
        field3: { type: 'array', items: { type: 'string' }, description: 'z'.repeat(800) },
      },
    };
    const tools = [];
    for (let i = 0; i < 10; i++) {
      tools.push({ type: 'function', function: { name: 'tool_' + i, parameters: bigSchema } });
    }
    const t = analyzeTask({
      messages: [{ role: 'user', content: 'Please help with this' }],
      tools,
    });
    assert.ok(t.estimatedInputTokens > 6000, `large schema input ${t.estimatedInputTokens} must exceed 6000`);
    assert.strictEqual(t.hasLongContext, true, 'large tool schema must trigger long_context');
  });

  test('C4 input + output within contextWindow; overflow blocks', () => {
    // 小请求 → 总量远小于窗口
    const small = analyzeTask({ messages: [{ role: 'user', content: 'hi' }] });
    const ok = hardConstraintBlock(
      { capabilities: { chat: 1 }, contextWindow: 100000, protocols: ['chat'] },
      { ...small, hardCapabilities: [] },
      'chat',
    );
    assert.strictEqual(ok, null);

    // 大请求（含输出预留）超出小窗口 → blocked
    const bigBody = {
      messages: [{ role: 'user', content: 'Summarize this document. ' + 'word '.repeat(5000) }],
      max_tokens: 4000,
    };
    const big = analyzeTask(bigBody);
    assert.ok(big.estimatedTotalTokens > big.estimatedInputTokens, 'total includes output reserve');
    const blocked = hardConstraintBlock(
      { capabilities: { chat: 1 }, contextWindow: 2000, protocols: ['chat'] },
      { ...big, hardCapabilities: [] },
      'chat',
    );
    assert.ok(blocked && blocked.includes('contextWindow'), 'overflow must block: ' + blocked);
  });

  test('C4 near-boundary: total (input+output) decides, not input alone', () => {
    // 输入很小但输出预留很大 → 总量超窗口 → blocked
    const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20000 };
    const t = analyzeTask(body);
    assert.ok(t.estimatedInputTokens < 100, 'input itself is small');
    assert.ok(t.estimatedTotalTokens > 10000, 'output reserve inflates total');
    const blocked = hardConstraintBlock(
      { capabilities: { chat: 1 }, contextWindow: 5000, protocols: ['chat'] },
      { ...t, hardCapabilities: [] },
      'chat',
    );
    assert.ok(blocked && blocked.includes('contextWindow'), 'must block by total (input+output)');
  });

  test('C4 image block pre-allocated', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }, { type: 'text', text: 'describe this' }] }],
    };
    const t = analyzeTask(body);
    assert.ok(t.estimatedInputTokens > 700, 'image pre-allocation must be counted');
  });
});
