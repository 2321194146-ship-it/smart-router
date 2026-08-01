// test/unit/protocol-anthropic.test.js
// Smart Router Mainline - Phase 1
// Anthropic 协议双向转换测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { anthropicToOpenAI, openaiToAnthropic, buildAnthropicError } from '../../src/protocols/anthropic.js';
import { createStreamState, chatChunkToAnthropicEvents, isMessageStop } from '../../src/protocols/anthropic-stream.js';

describe('Anthropic Protocol Conversion', () => {
  // --------------------------------------------------------------------------
  // anthropicToOpenAI
  // --------------------------------------------------------------------------

  describe('anthropicToOpenAI', () => {
    test('converts system string to system message', () => {
      const body = {
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = anthropicToOpenAI(body);
      assert.strictEqual(result.messages[0].role, 'system');
      assert.strictEqual(result.messages[0].content, 'You are a helpful assistant.');
    });

    test('converts system array to system message', () => {
      const body = {
        system: [
          { type: 'text', text: 'You are helpful.' },
          { type: 'text', text: 'Be concise.' },
        ],
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = anthropicToOpenAI(body);
      assert.strictEqual(result.messages[0].role, 'system');
      assert.strictEqual(result.messages[0].content, 'You are helpful.\nBe concise.');
    });

    test('converts user text content', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hello, world!' }],
      };
      const result = anthropicToOpenAI(body);
      const userMsg = result.messages.find((m) => m.role === 'user');
      assert.ok(userMsg);
      assert.strictEqual(userMsg.content, 'Hello, world!');
    });

    test('converts user tool_result to tool message', () => {
      const body = {
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu-123',
            content: 'Sunny, 72F',
          }],
        }],
      };
      const result = anthropicToOpenAI(body);
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      assert.ok(toolMsg);
      assert.strictEqual(toolMsg.tool_call_id, 'toolu-123');
      assert.strictEqual(toolMsg.content, 'Sunny, 72F');
    });

    test('converts assistant text content', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'I can help with that.' }],
      };
      const result = anthropicToOpenAI(body);
      const assistantMsg = result.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg);
      assert.strictEqual(assistantMsg.content, 'I can help with that.');
    });

    test('converts assistant tool_use to tool_calls', () => {
      const body = {
        messages: [{
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu-456',
            name: 'get_weather',
            input: { city: 'NYC' },
          }],
        }],
      };
      const result = anthropicToOpenAI(body);
      const assistantMsg = result.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg);
      assert.ok(assistantMsg.tool_calls);
      assert.strictEqual(assistantMsg.tool_calls.length, 1);
      assert.strictEqual(assistantMsg.tool_calls[0].id, 'toolu-456');
      assert.strictEqual(assistantMsg.tool_calls[0].type, 'function');
      assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'get_weather');
      assert.deepStrictEqual(JSON.parse(assistantMsg.tool_calls[0].function.arguments), { city: 'NYC' });
    });

    test('converts tools with input_schema', () => {
      const body = {
        messages: [],
        tools: [{
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        }],
      };
      const result = anthropicToOpenAI(body);
      assert.ok(result.tools);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].type, 'function');
      assert.strictEqual(result.tools[0].function.name, 'get_weather');
      assert.strictEqual(result.tools[0].function.description, 'Get weather for a city');
      assert.deepStrictEqual(result.tools[0].function.parameters, {
        type: 'object',
        properties: { city: { type: 'string' } },
      });
    });

    test('converts tool_choice auto', () => {
      const body = {
        messages: [],
        tool_choice: { type: 'auto' },
      };
      const result = anthropicToOpenAI(body);
      assert.strictEqual(result.tool_choice, 'auto');
    });

    test('converts tool_choice any to required', () => {
      const body = {
        messages: [],
        tool_choice: { type: 'any' },
      };
      const result = anthropicToOpenAI(body);
      assert.strictEqual(result.tool_choice, 'required');
    });

    test('converts tool_choice tool to function', () => {
      const body = {
        messages: [],
        tool_choice: { type: 'tool', name: 'get_weather' },
      };
      const result = anthropicToOpenAI(body);
      assert.deepStrictEqual(result.tool_choice, {
        type: 'function',
        function: { name: 'get_weather' },
      });
    });

    test('removes anthropic-specific fields', () => {
      const body = {
        messages: [],
        thinking: { type: 'enabled', budget_tokens: 5000 },
        anthropic_beta: ['max-tokens-3-5-sonnet-2024-07-15'],
        anthropic_version: '2023-06-01',
        top_k: 40,
        metadata: { user_id: 'u1' },
      };
      const result = anthropicToOpenAI(body);
      assert.ok(!('thinking' in result), 'thinking should be removed');
      assert.ok(!('anthropic_beta' in result), 'anthropic_beta should be removed');
      assert.ok(!('anthropic_version' in result), 'anthropic_version should be removed');
      assert.ok(!('top_k' in result), 'top_k should be removed');
      assert.ok(!('metadata' in result), 'metadata should be removed');
    });

    test('preserves max_tokens and model', () => {
      const body = {
        model: 'claude-3-sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = anthropicToOpenAI(body);
      assert.strictEqual(result.model, 'claude-3-sonnet');
      assert.strictEqual(result.max_tokens, 1024);
    });

    test('converts stop_sequences to stop', () => {
      const body = {
        messages: [],
        stop_sequences: ['\n\n', 'END'],
      };
      const result = anthropicToOpenAI(body);
      assert.deepStrictEqual(result.stop, ['\n\n', 'END']);
    });
  });

  // --------------------------------------------------------------------------
  // openaiToAnthropic
  // --------------------------------------------------------------------------

  describe('openaiToAnthropic', () => {
    test('converts text response to content array', () => {
      const chatResponse = {
        id: 'chatcmpl-1',
        model: 'gpt-4',
        choices: [{
          message: { content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = openaiToAnthropic(chatResponse);
      assert.strictEqual(result.type, 'message');
      assert.strictEqual(result.role, 'assistant');
      assert.ok(Array.isArray(result.content));
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, 'text');
      assert.strictEqual(result.content[0].text, 'Hello!');
    });

    test('converts tool_calls to tool_use', () => {
      const chatResponse = {
        id: 'chatcmpl-2',
        model: 'gpt-4',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"NYC"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
      const result = openaiToAnthropic(chatResponse);
      const toolUse = result.content.find((b) => b.type === 'tool_use');
      assert.ok(toolUse);
      assert.strictEqual(toolUse.id, 'call-1');
      assert.strictEqual(toolUse.name, 'get_weather');
      assert.deepStrictEqual(toolUse.input, { city: 'NYC' });
    });

    test('maps stop_reason: stop -> end_turn', () => {
      const chatResponse = {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      };
      const result = openaiToAnthropic(chatResponse);
      assert.strictEqual(result.stop_reason, 'end_turn');
    });

    test('maps stop_reason: length -> max_tokens', () => {
      const chatResponse = {
        choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
      };
      const result = openaiToAnthropic(chatResponse);
      assert.strictEqual(result.stop_reason, 'max_tokens');
    });

    test('maps stop_reason: tool_calls -> tool_use', () => {
      const chatResponse = {
        choices: [{ message: { content: 'hi' }, finish_reason: 'tool_calls' }],
      };
      const result = openaiToAnthropic(chatResponse);
      assert.strictEqual(result.stop_reason, 'tool_use');
    });

    test('maps usage correctly', () => {
      const chatResponse = {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      };
      const result = openaiToAnthropic(chatResponse);
      assert.strictEqual(result.usage.input_tokens, 100);
      assert.strictEqual(result.usage.output_tokens, 50);
    });

    test('handles null chatResponse', () => {
      const result = openaiToAnthropic(null, { model: 'claude-3' });
      assert.strictEqual(result.type, 'message');
      assert.strictEqual(result.role, 'assistant');
      assert.strictEqual(result.model, 'claude-3');
      assert.strictEqual(result.stop_reason, 'end_turn');
    });
  });

  // --------------------------------------------------------------------------
  // 流式转换
  // --------------------------------------------------------------------------

  describe('Stream Conversion', () => {
    test('createStreamState initializes correctly', () => {
      const state = createStreamState();
      assert.strictEqual(state.messageStarted, false);
      assert.strictEqual(state.currentBlock, null);
      assert.deepStrictEqual(state.contentBlocks, []);
      assert.strictEqual(state.totalText, '');
      assert.strictEqual(state.hasContent, false);
      assert.strictEqual(state.nextBlockIndex, 0);
      assert.strictEqual(state.messageStopped, false);
      assert.strictEqual(state.stopReason, null);
      assert.strictEqual(state.messageId, null);
      assert.strictEqual(state.lastUsage, null);
    });

    test('chatChunkToAnthropicEvents sends message_start on first chunk', () => {
      const state = createStreamState();
      const chunk = {
        id: 'msg-1',
        model: 'claude-3-sonnet',
        choices: [{ delta: { content: 'Hello' } }],
      };
      const events = chatChunkToAnthropicEvents(chunk, state, { model: 'claude-3-sonnet' });
      const startEvent = events.find((e) => e.type === 'message_start');
      assert.ok(startEvent);
      assert.strictEqual(startEvent.message.id, 'msg-1');
      assert.strictEqual(startEvent.message.role, 'assistant');
      assert.strictEqual(startEvent.message.model, 'claude-3-sonnet');
      assert.strictEqual(state.messageStarted, true);
    });

    test('chatChunkToAnthropicEvents sends content_block_delta for text', () => {
      const state = createStreamState();
      const chunk = {
        id: 'msg-1',
        model: 'claude-3-sonnet',
        choices: [{ delta: { content: 'Hello world' } }],
      };
      const events = chatChunkToAnthropicEvents(chunk, state, { model: 'claude-3-sonnet' });
      const deltaEvent = events.find((e) => e.type === 'content_block_delta');
      assert.ok(deltaEvent);
      assert.strictEqual(deltaEvent.delta.type, 'text_delta');
      assert.strictEqual(deltaEvent.delta.text, 'Hello world');
    });

    test('chatChunkToAnthropicEvents handles tool_call delta', () => {
      const state = createStreamState();
      const chunk = {
        id: 'msg-1',
        model: 'claude-3-sonnet',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'toolu-1',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            }],
          },
        }],
      };
      const events = chatChunkToAnthropicEvents(chunk, state, { model: 'claude-3-sonnet' });
      const blockStart = events.find((e) => e.type === 'content_block_start');
      assert.ok(blockStart);
      assert.strictEqual(blockStart.content_block.type, 'tool_use');
      assert.strictEqual(blockStart.content_block.id, 'toolu-1');
      assert.strictEqual(blockStart.content_block.name, 'get_weather');

      const deltaEvent = events.find((e) =>
        e.type === 'content_block_delta' && e.delta.type === 'input_json_delta'
      );
      assert.ok(deltaEvent);
      assert.strictEqual(deltaEvent.delta.partial_json, '{"city":"NYC"}');
    });

    test('chatChunkToAnthropicEvents sends message_stop on finish', () => {
      const state = createStreamState();
      // First chunk to start message
      const chunk1 = {
        id: 'msg-1',
        model: 'claude-3-sonnet',
        choices: [{ delta: { content: 'Hello' } }],
      };
      chatChunkToAnthropicEvents(chunk1, state, { model: 'claude-3-sonnet' });

      // Finish chunk
      const chunk2 = {
        choices: [{ finish_reason: 'stop' }],
      };
      const events = chatChunkToAnthropicEvents(chunk2, state, { model: 'claude-3-sonnet' });
      const stopEvent = events.find((e) => e.type === 'message_stop');
      assert.ok(stopEvent);
      const deltaEvent = events.find((e) => e.type === 'message_delta');
      assert.ok(deltaEvent);
      assert.strictEqual(deltaEvent.delta.stop_reason, 'end_turn');
      assert.strictEqual(state.messageStopped, true);
    });

    test('isMessageStop detects message_stop event', () => {
      assert.strictEqual(isMessageStop({ type: 'message_stop' }), true);
      assert.strictEqual(isMessageStop({ type: 'message_start' }), false);
      assert.strictEqual(isMessageStop(null), false);
    });

    test('isMessageStop handles JSON string', () => {
      assert.strictEqual(isMessageStop('{"type":"message_stop"}'), true);
      assert.strictEqual(isMessageStop('{"type":"message_start"}'), false);
      assert.strictEqual(isMessageStop('invalid json'), false);
    });
  });

  // --------------------------------------------------------------------------
  // 错误响应
  // --------------------------------------------------------------------------

  describe('buildAnthropicError', () => {
    test('creates error response', () => {
      const result = buildAnthropicError({ message: 'Something failed', type: 'server_error' });
      assert.strictEqual(result.type, 'error');
      assert.ok(result.error);
      assert.strictEqual(result.error.message, 'Something failed');
      assert.strictEqual(result.error.type, 'api_error');
    });

    test('maps rate_limit to rate_limit_error', () => {
      const result = buildAnthropicError({ message: 'Too many requests', type: 'rate_limit_transient' });
      assert.strictEqual(result.error.type, 'rate_limit_error');
    });

    test('maps auth to authentication_error', () => {
      const result = buildAnthropicError({ message: 'Invalid API key', type: 'auth_invalid' });
      assert.strictEqual(result.error.type, 'authentication_error');
    });

    test('maps not_found to not_found_error', () => {
      const result = buildAnthropicError({ message: 'Model not found', type: 'forbidden_model' });
      assert.strictEqual(result.error.type, 'not_found_error');
    });

    test('maps invalid_request_error', () => {
      const result = buildAnthropicError({ message: 'Bad request', type: 'invalid_request_error' });
      assert.strictEqual(result.error.type, 'invalid_request_error');
    });

    test('handles null error', () => {
      const result = buildAnthropicError(null);
      assert.strictEqual(result.type, 'error');
      assert.strictEqual(result.error.type, 'api_error');
      assert.strictEqual(result.error.message, 'An unexpected error occurred');
    });

    test('defaults to api_error for unknown types', () => {
      const result = buildAnthropicError({ message: 'Unknown', type: 'something_weird' });
      assert.strictEqual(result.error.type, 'api_error');
    });
  });
});
