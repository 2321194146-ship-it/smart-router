// test/unit/claude-code-compat.test.js
// Smart Router Mainline - Phase 1
// Claude Code 兼容补丁测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  handleHeadRequest,
  normalizePath,
  handleCountTokens,
  handleThinkingParam,
  cleanThinkingBlocks,
  cleanReasoningContent,
  cleanThinkingProcessLeak,
  stripAnthropicFields,
  identifyAgentByUA,
  handleContextManagement,
  handleOutputConfig,
  applyClaudeCodePatches,
} from '../../src/agent/compatibility.js';

describe('Claude Code Compatibility Patches', () => {
  // --------------------------------------------------------------------------
  // 1. HEAD /v1 探活
  // --------------------------------------------------------------------------

  describe('handleHeadRequest', () => {
    test('returns 200 for /v1', () => {
      const result = handleHeadRequest('/v1');
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.headers);
      assert.strictEqual(result.headers['content-length'], '0');
    });

    test('returns 200 for /v1/', () => {
      const result = handleHeadRequest('/v1/');
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.statusCode, 200);
    });

    test('returns handled=false for unknown paths', () => {
      const result = handleHeadRequest('/v1/messages');
      assert.strictEqual(result.handled, false);
    });

    test('handles /v1/v1/ via normalization', () => {
      const result = handleHeadRequest('/v1/v1/');
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.statusCode, 200);
    });
  });

  // --------------------------------------------------------------------------
  // 2. /v1/v1/ 路径归一化
  // --------------------------------------------------------------------------

  describe('normalizePath', () => {
    test('converts /v1/v1/messages to /v1/messages', () => {
      assert.strictEqual(normalizePath('/v1/v1/messages'), '/v1/messages');
    });

    test('does not affect /v1/messages', () => {
      assert.strictEqual(normalizePath('/v1/messages'), '/v1/messages');
    });

    test('preserves query string', () => {
      assert.strictEqual(normalizePath('/v1/v1/messages?x=1'), '/v1/messages?x=1');
    });

    test('handles /v1/v1 at end of string', () => {
      assert.strictEqual(normalizePath('/v1/v1'), '/v1');
    });

    test('does not affect paths without double /v1', () => {
      assert.strictEqual(normalizePath('/v1/chat/completions'), '/v1/chat/completions');
    });

    test('returns non-string as-is', () => {
      assert.strictEqual(normalizePath(null), null);
      assert.strictEqual(normalizePath(undefined), undefined);
      assert.strictEqual(normalizePath(123), 123);
    });

    test('returns empty string as-is', () => {
      assert.strictEqual(normalizePath(''), '');
    });
  });

  // --------------------------------------------------------------------------
  // 3. count_tokens 兼容
  // --------------------------------------------------------------------------

  describe('handleCountTokens', () => {
    test('returns estimated tokens', () => {
      const body = { messages: [{ role: 'user', content: 'Hello, world!' }] };
      const result = handleCountTokens('/v1/messages/count_tokens', body);
      assert.strictEqual(result.handled, true);
      assert.ok(result.response);
      assert.ok(result.response.input_tokens > 0);
      assert.strictEqual(typeof result.response.input_tokens, 'number');
    });

    test('returns handled=false for non-count_tokens paths', () => {
      const result = handleCountTokens('/v1/messages', { messages: [] });
      assert.strictEqual(result.handled, false);
    });

    test('returns non-zero for empty body', () => {
      const result = handleCountTokens('/v1/messages/count_tokens', {});
      assert.strictEqual(result.handled, true);
      assert.ok(result.response.input_tokens >= 1);
    });

    test('handles body without messages array', () => {
      const result = handleCountTokens('/v1/messages/count_tokens', { foo: 'bar' });
      assert.strictEqual(result.handled, true);
      assert.ok(result.response.input_tokens >= 1);
    });
  });

  // --------------------------------------------------------------------------
  // 4. thinking 参数处理
  // --------------------------------------------------------------------------

  describe('handleThinkingParam', () => {
    test('converts thinking to reasoning_effort high (>4000)', () => {
      const body = { thinking: { type: 'enabled', budget_tokens: 5000 } };
      const result = handleThinkingParam(body);
      assert.strictEqual(result.reasoningEffort, 'high');
      assert.ok(result.thinkingConfig);
      assert.strictEqual(result.thinkingConfig.type, 'enabled');
      assert.strictEqual(result.thinkingConfig.budget_tokens, 5000);
    });

    test('converts thinking to reasoning_effort medium (<=4000)', () => {
      const body = { thinking: { type: 'enabled', budget_tokens: 4000 } };
      const result = handleThinkingParam(body);
      assert.strictEqual(result.reasoningEffort, 'medium');
      assert.ok(result.thinkingConfig);
    });

    test('returns undefined when no thinking', () => {
      const body = { model: 'gpt-4' };
      const result = handleThinkingParam(body);
      assert.strictEqual(result.reasoningEffort, undefined);
      assert.strictEqual(result.thinkingConfig, null);
    });

    test('returns undefined when thinking type is not enabled', () => {
      const body = { thinking: { type: 'disabled' } };
      const result = handleThinkingParam(body);
      assert.strictEqual(result.reasoningEffort, undefined);
      assert.ok(result.thinkingConfig);
      assert.strictEqual(result.thinkingConfig.type, 'disabled');
    });

    test('does not modify original body', () => {
      const body = { thinking: { type: 'enabled', budget_tokens: 5000 } };
      const original = JSON.parse(JSON.stringify(body));
      handleThinkingParam(body);
      assert.deepStrictEqual(body, original);
    });
  });

  // --------------------------------------------------------------------------
  // 5. thinking 内容块清洗
  // --------------------------------------------------------------------------

  describe('cleanThinkingBlocks', () => {
    test('replaces thinking blocks with [thinking]', () => {
      const messages = [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: 'Hello!' },
        ],
      }];
      const result = cleanThinkingBlocks(messages);
      assert.strictEqual(result[0].content[0].type, 'text');
      assert.strictEqual(result[0].content[0].text, '[thinking]');
      assert.strictEqual(result[0].content[1].type, 'text');
      assert.strictEqual(result[0].content[1].text, 'Hello!');
    });

    test('preserves text blocks', () => {
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: 'Hi there' }],
      }];
      const result = cleanThinkingBlocks(messages);
      assert.strictEqual(result[0].content[0].type, 'text');
      assert.strictEqual(result[0].content[0].text, 'Hi there');
    });

    test('handles string content', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      const result = cleanThinkingBlocks(messages);
      assert.strictEqual(result[0].content, 'Hello');
    });

    test('does not modify original messages', () => {
      const messages = [{
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'secret' }],
      }];
      const original = JSON.parse(JSON.stringify(messages));
      cleanThinkingBlocks(messages);
      assert.deepStrictEqual(messages, original);
    });

    test('returns non-array as-is', () => {
      assert.strictEqual(cleanThinkingBlocks(null), null);
      assert.strictEqual(cleanThinkingBlocks('not array'), 'not array');
    });
  });

  // --------------------------------------------------------------------------
  // 6. reasoning_content 清理
  // --------------------------------------------------------------------------

  describe('cleanReasoningContent', () => {
    test('removes from message', () => {
      const body = {
        choices: [{
          message: { reasoning_content: 'thinking...', content: 'Hello!' },
        }],
      };
      const result = cleanReasoningContent(body);
      assert.ok(!('reasoning_content' in result.choices[0].message));
      assert.strictEqual(result.choices[0].message.content, 'Hello!');
    });

    test('removes from delta', () => {
      const body = {
        choices: [{
          delta: { reasoning_content: 'thinking...', content: 'Hello!' },
        }],
      };
      const result = cleanReasoningContent(body);
      assert.ok(!('reasoning_content' in result.choices[0].delta));
      assert.strictEqual(result.choices[0].delta.content, 'Hello!');
    });

    test('removes top-level reasoning_content', () => {
      const body = { reasoning_content: 'top-level', choices: [] };
      const result = cleanReasoningContent(body);
      assert.ok(!('reasoning_content' in result));
    });

    test('handles nested objects', () => {
      const body = {
        reasoning_content: 'top',
        choices: [
          { message: { reasoning_content: 'msg1', content: 'a' } },
          { delta: { reasoning_content: 'delta1', content: 'b' } },
        ],
      };
      const result = cleanReasoningContent(body);
      assert.ok(!('reasoning_content' in result));
      assert.ok(!('reasoning_content' in result.choices[0].message));
      assert.ok(!('reasoning_content' in result.choices[1].delta));
      assert.strictEqual(result.choices[0].message.content, 'a');
      assert.strictEqual(result.choices[1].delta.content, 'b');
    });

    test('does not modify original body', () => {
      const body = {
        choices: [{ message: { reasoning_content: 'thinking', content: 'hi' } }],
      };
      const original = JSON.parse(JSON.stringify(body));
      cleanReasoningContent(body);
      assert.deepStrictEqual(body, original);
    });
  });

  // --------------------------------------------------------------------------
  // 7. "Thinking Process:" 泄漏防护
  // --------------------------------------------------------------------------

  describe('cleanThinkingProcessLeak', () => {
    test('removes "Thinking Process:" prefix', () => {
      const content = 'Thinking Process: let me analyze this\n\nThe actual answer is 42.';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, 'The actual answer is 42.');
    });

    test('handles "Let me think" pattern', () => {
      const content = 'Let me think about this\n\nThe answer is 42.';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, 'The answer is 42.');
    });

    test('preserves normal content', () => {
      const content = 'This is a normal response without any thinking leaks.';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, content);
    });

    test('handles "Let\'s analyze" pattern', () => {
      const content = 'Let\'s analyze the data\n\nThe result is positive.';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, 'The result is positive.');
    });

    test('preserves content before the leak marker', () => {
      const content = 'Sure! Thinking Process: blah\n\nReal answer.';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, 'Sure! Real answer.');
    });

    test('removes all content when no paragraph separator', () => {
      const content = 'Thinking Process: blah blah blah';
      const result = cleanThinkingProcessLeak(content);
      assert.strictEqual(result, '');
    });

    test('returns non-string as-is', () => {
      assert.strictEqual(cleanThinkingProcessLeak(null), null);
      assert.strictEqual(cleanThinkingProcessLeak(123), 123);
    });

    test('returns empty string as-is', () => {
      assert.strictEqual(cleanThinkingProcessLeak(''), '');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Anthropic 专有字段清理
  // --------------------------------------------------------------------------

  describe('stripAnthropicFields', () => {
    test('removes thinking, anthropic_beta, anthropic_version', () => {
      const body = {
        model: 'gpt-4',
        thinking: { type: 'enabled' },
        anthropic_beta: ['max-tokens'],
        anthropic_version: '2023-06-01',
        messages: [],
      };
      const result = stripAnthropicFields(body);
      assert.ok(!('thinking' in result.cleanedBody));
      assert.ok(!('anthropic_beta' in result.cleanedBody));
      assert.ok(!('anthropic_version' in result.cleanedBody));
      assert.strictEqual(result.cleanedBody.model, 'gpt-4');
    });

    test('returns warnings for removed fields', () => {
      const body = {
        thinking: { type: 'enabled' },
        anthropic_version: '2023-06-01',
      };
      const result = stripAnthropicFields(body);
      assert.ok(result.warnings.length >= 2);
      for (const w of result.warnings) {
        assert.strictEqual(w.patch, 'stripAnthropicFields');
        assert.strictEqual(w.action, 'removed');
        assert.ok(w.field);
        assert.ok(w.message);
      }
    });

    test('does not modify original body', () => {
      const body = {
        thinking: { type: 'enabled' },
        anthropic_version: '2023-06-01',
        model: 'gpt-4',
      };
      const original = JSON.parse(JSON.stringify(body));
      stripAnthropicFields(body);
      assert.deepStrictEqual(body, original);
    });

    test('returns no warnings when no fields to remove', () => {
      const body = { model: 'gpt-4', messages: [] };
      const result = stripAnthropicFields(body);
      assert.strictEqual(result.warnings.length, 0);
    });

    test('handles null body', () => {
      const result = stripAnthropicFields(null);
      assert.strictEqual(result.cleanedBody, null);
      assert.strictEqual(result.warnings.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Agent UA 识别
  // --------------------------------------------------------------------------

  describe('identifyAgentByUA', () => {
    test('identifies claude-cli', () => {
      const result = identifyAgentByUA('claude-cli/2.1.206');
      assert.strictEqual(result.agentId, 'claude-code');
      assert.strictEqual(result.agentType, 'claude-code');
    });

    test('identifies Codex', () => {
      const result = identifyAgentByUA('codex/1.0.7');
      assert.strictEqual(result.agentId, 'codex');
      assert.strictEqual(result.agentType, 'codex');
    });

    test('identifies OpenAI SDK', () => {
      const result = identifyAgentByUA('OpenAI/Python 1.0.7');
      assert.strictEqual(result.agentId, 'openai-sdk');
      assert.strictEqual(result.agentType, 'openai-sdk');
    });

    test('extracts version from claude-cli', () => {
      const result = identifyAgentByUA('claude-cli/2.1.206');
      assert.strictEqual(result.version, '2.1.206');
    });

    test('extracts version from codex', () => {
      const result = identifyAgentByUA('codex/1.0.7');
      assert.strictEqual(result.version, '1.0.7');
    });

    test('extracts version from OpenAI SDK', () => {
      const result = identifyAgentByUA('OpenAI/Python 1.0.7');
      assert.ok(result.version);
      assert.strictEqual(result.version, '1.0.7');
    });

    test('returns generic for unknown UA', () => {
      const result = identifyAgentByUA('some-unknown-agent/1.0');
      assert.strictEqual(result.agentId, 'generic');
      assert.strictEqual(result.agentType, 'generic');
      assert.strictEqual(result.version, null);
    });

    test('handles empty/null UA', () => {
      const result = identifyAgentByUA('');
      assert.strictEqual(result.agentType, 'generic');
      const result2 = identifyAgentByUA(null);
      assert.strictEqual(result2.agentType, 'generic');
    });
  });

  // --------------------------------------------------------------------------
  // context_management 处理
  // --------------------------------------------------------------------------

  describe('handleContextManagement', () => {
    test('removes field by default', () => {
      const body = { model: 'gpt-4', context_management: { type: 'tool' } };
      const result = handleContextManagement(body);
      assert.ok(!('context_management' in result.body));
    });

    test('passes through when upstream supports', () => {
      const body = { model: 'gpt-4', context_management: { type: 'tool' } };
      const result = handleContextManagement(body, { upstreamSupports: true });
      assert.ok('context_management' in result.body);
      assert.strictEqual(result.warnings.length, 0);
    });

    test('generates warning when removed', () => {
      const body = { model: 'gpt-4', context_management: { type: 'tool' } };
      const result = handleContextManagement(body);
      assert.strictEqual(result.warnings.length, 1);
      assert.strictEqual(result.warnings[0].patch, 'handleContextManagement');
      assert.strictEqual(result.warnings[0].field, 'context_management');
      assert.strictEqual(result.warnings[0].action, 'removed');
    });

    test('does nothing when field is absent', () => {
      const body = { model: 'gpt-4' };
      const result = handleContextManagement(body);
      assert.strictEqual(result.warnings.length, 0);
      assert.strictEqual(result.body, body);
    });
  });

  // --------------------------------------------------------------------------
  // output_config 处理
  // --------------------------------------------------------------------------

  describe('handleOutputConfig', () => {
    test('removes field by default', () => {
      const body = { model: 'gpt-4', output_config: { max_tokens: 1000 } };
      const result = handleOutputConfig(body);
      assert.ok(!('output_config' in result.body));
    });

    test('passes through when upstream supports', () => {
      const body = { model: 'gpt-4', output_config: { max_tokens: 1000 } };
      const result = handleOutputConfig(body, { upstreamSupports: true });
      assert.ok('output_config' in result.body);
      assert.strictEqual(result.warnings.length, 0);
    });

    test('generates warning when removed', () => {
      const body = { model: 'gpt-4', output_config: { max_tokens: 1000 } };
      const result = handleOutputConfig(body);
      assert.strictEqual(result.warnings.length, 1);
      assert.strictEqual(result.warnings[0].patch, 'handleOutputConfig');
      assert.strictEqual(result.warnings[0].field, 'output_config');
      assert.strictEqual(result.warnings[0].action, 'removed');
    });

    test('does nothing when field is absent', () => {
      const body = { model: 'gpt-4' };
      const result = handleOutputConfig(body);
      assert.strictEqual(result.warnings.length, 0);
      assert.strictEqual(result.body, body);
    });
  });

  // --------------------------------------------------------------------------
  // applyClaudeCodePatches 统一入口
  // --------------------------------------------------------------------------

  describe('applyClaudeCodePatches', () => {
    test('applies all patches for Claude Code', () => {
      const headers = { 'user-agent': 'claude-cli/2.1.206' };
      const body = {
        model: 'gpt-4',
        messages: [],
        thinking: { type: 'enabled', budget_tokens: 5000 },
        anthropic_version: '2023-06-01',
        context_management: { type: 'tool' },
        output_config: { max_tokens: 1000 },
      };
      const pathname = '/v1/v1/messages';

      const result = applyClaudeCodePatches(headers, body, pathname);

      assert.strictEqual(result.isClaudeCode, true);
      // Path should be normalized
      assert.strictEqual(result.pathname, '/v1/messages');
      // reasoning_effort should be set
      assert.strictEqual(result.reasoningEffort, 'high');
      assert.ok(result.thinkingConfig);
      // Anthropic fields should be removed from body
      assert.ok(!('thinking' in result.body));
      assert.ok(!('anthropic_version' in result.body));
      assert.ok(!('context_management' in result.body));
      assert.ok(!('output_config' in result.body));
      // reasoning_effort should be added to body
      assert.strictEqual(result.body.reasoning_effort, 'high');
      // patches list should include applied patches
      assert.ok(result.patches.includes('normalizePath'));
      assert.ok(result.patches.includes('handleThinkingParam'));
      assert.ok(result.patches.includes('stripAnthropicFields'));
      assert.ok(result.patches.includes('handleContextManagement'));
      assert.ok(result.patches.includes('handleOutputConfig'));
    });

    test('does nothing for non-Claude Code', () => {
      const headers = { 'user-agent': 'openai/1.0' };
      const body = { model: 'gpt-4', messages: [], thinking: { type: 'enabled' } };
      const pathname = '/v1/chat/completions';

      const result = applyClaudeCodePatches(headers, body, pathname);

      assert.strictEqual(result.isClaudeCode, false);
      assert.strictEqual(result.patches.length, 0);
      assert.strictEqual(result.warnings.length, 0);
      assert.strictEqual(result.reasoningEffort, undefined);
      assert.strictEqual(result.thinkingConfig, null);
      // Body should be unchanged (original reference)
      assert.ok('thinking' in result.body);
    });

    test('returns patches list and warnings', () => {
      const headers = { 'user-agent': 'claude-cli/2.1.206' };
      const body = {
        model: 'gpt-4',
        messages: [],
        thinking: { type: 'enabled', budget_tokens: 5000 },
        anthropic_version: '2023-06-01',
      };
      const pathname = '/v1/messages';

      const result = applyClaudeCodePatches(headers, body, pathname);

      assert.ok(Array.isArray(result.patches));
      assert.ok(result.patches.length > 0);
      assert.ok(Array.isArray(result.warnings));
      assert.ok(result.warnings.length > 0);
      // Each warning should have the standard format
      for (const w of result.warnings) {
        assert.ok(w.patch);
        assert.ok(w.field);
        assert.ok(w.action);
        assert.ok(w.message);
      }
      // agent info should be present
      assert.ok(result.agent);
      assert.strictEqual(result.agent.agentType, 'claude-code');
    });

    test('does not modify original input body', () => {
      const headers = { 'user-agent': 'claude-cli/2.1.206' };
      const body = {
        model: 'gpt-4',
        messages: [],
        thinking: { type: 'enabled', budget_tokens: 5000 },
        anthropic_version: '2023-06-01',
      };
      const original = JSON.parse(JSON.stringify(body));

      applyClaudeCodePatches(headers, body, '/v1/messages');

      assert.deepStrictEqual(body, original);
    });

    test('detects Claude Code by path /v1/messages', () => {
      const headers = {};
      const body = { model: 'gpt-4', messages: [] };
      const pathname = '/v1/messages';

      const result = applyClaudeCodePatches(headers, body, pathname);
      assert.strictEqual(result.isClaudeCode, true);
    });
  });
});
