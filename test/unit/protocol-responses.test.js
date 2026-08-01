// test/unit/protocol-responses.test.js
// Smart Router Mainline - Phase 1
// Responses API 协议转换测试
//
// 使用 Node.js 内置 node:test 和 node:assert，无第三方依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { responsesToChat, chatToResponses, buildResponsesError } from '../../src/protocols/responses.js';
import { chatDeltaToResponsesEvents, isResponseCompleted, isResponseIncomplete } from '../../src/protocols/responses-stream.js';

// createStreamState is not exported from responses-stream.js, so we create the state inline.
function makeStreamState() {
  return {
    responseCreated: false,
    responseId: null,
    model: null,
    createdAt: Math.floor(Date.now() / 1000),
    currentMessageIndex: -1,
    currentContentIndex: -1,
    messageId: null,
    accumulatedText: '',
    toolCallStates: new Map(),
    currentToolCallIndex: -1,
    nextOutputIndex: 0,
    outputItems: [],
    finishReason: null,
    usage: null,
    completed: false,
    incomplete: false,
  };
}

describe('Responses Protocol Conversion', () => {
  // --------------------------------------------------------------------------
  // responsesToChat
  // --------------------------------------------------------------------------

  describe('responsesToChat', () => {
    test('converts string input to user message', () => {
      const body = { model: 'gpt-4', input: 'Hello, world!' };
      const result = responsesToChat(body);
      assert.ok(result.messages);
      const userMsg = result.messages.find((m) => m.role === 'user');
      assert.ok(userMsg);
      assert.strictEqual(userMsg.content, 'Hello, world!');
    });

    test('converts array input with message items', () => {
      const body = {
        model: 'gpt-4',
        input: [
          { type: 'message', role: 'user', content: 'What is the weather?' },
          { type: 'message', role: 'assistant', content: 'Let me check.' },
        ],
      };
      const result = responsesToChat(body);
      assert.ok(result.messages.length >= 2);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.strictEqual(result.messages[0].content, 'What is the weather?');
      assert.strictEqual(result.messages[1].role, 'assistant');
      assert.strictEqual(result.messages[1].content, 'Let me check.');
    });

    test('converts function_call_output to tool messages', () => {
      const body = {
        model: 'gpt-4',
        input: [
          { type: 'message', role: 'user', content: 'What is the weather in NYC?' },
          { type: 'function_call_output', call_id: 'call-1', output: 'Sunny, 72F' },
        ],
      };
      const result = responsesToChat(body);
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      assert.ok(toolMsg);
      assert.strictEqual(toolMsg.tool_call_id, 'call-1');
      assert.strictEqual(toolMsg.content, 'Sunny, 72F');
    });

    test('converts instructions to system message', () => {
      const body = {
        model: 'gpt-4',
        instructions: 'You are a helpful assistant.',
        input: 'Hi',
      };
      const result = responsesToChat(body);
      assert.strictEqual(result.messages[0].role, 'system');
      assert.strictEqual(result.messages[0].content, 'You are a helpful assistant.');
    });

    test('converts tools to chat format', () => {
      const body = {
        model: 'gpt-4',
        input: 'Hi',
        tools: [{
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        }],
      };
      const result = responsesToChat(body);
      assert.ok(result.tools);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].type, 'function');
      assert.strictEqual(result.tools[0].function.name, 'get_weather');
      assert.strictEqual(result.tools[0].function.description, 'Get weather');
    });

    test('converts max_output_tokens to max_tokens', () => {
      const body = {
        model: 'gpt-4',
        input: 'Hi',
        max_output_tokens: 1024,
      };
      const result = responsesToChat(body);
      assert.strictEqual(result.max_tokens, 1024);
      assert.ok(!('max_output_tokens' in result));
    });

    test('forces stream to false', () => {
      const body = { model: 'gpt-4', input: 'Hi', stream: true };
      const result = responsesToChat(body);
      assert.strictEqual(result.stream, false);
    });

    test('converts function_call to assistant tool_calls', () => {
      const body = {
        model: 'gpt-4',
        input: [
          { type: 'message', role: 'user', content: 'weather?' },
          { type: 'function_call', call_id: 'call-1', name: 'get_weather', arguments: '{"city":"NYC"}' },
        ],
      };
      const result = responsesToChat(body);
      const assistantMsg = result.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg);
      assert.ok(assistantMsg.tool_calls);
      assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'get_weather');
      assert.strictEqual(assistantMsg.tool_calls[0].function.arguments, '{"city":"NYC"}');
    });
  });

  // --------------------------------------------------------------------------
  // chatToResponses
  // --------------------------------------------------------------------------

  describe('chatToResponses', () => {
    test('converts text response to output array', () => {
      const chatResponse = {
        id: 'chatcmpl-1',
        model: 'gpt-4',
        choices: [{
          message: { content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = chatToResponses(chatResponse);
      assert.strictEqual(result.object, 'response');
      assert.ok(Array.isArray(result.output));
      assert.ok(result.output.length > 0);
      const msgItem = result.output.find((o) => o.type === 'message');
      assert.ok(msgItem);
      assert.strictEqual(msgItem.role, 'assistant');
      assert.strictEqual(msgItem.content[0].type, 'output_text');
      assert.strictEqual(msgItem.content[0].text, 'Hello!');
    });

    test('converts tool_calls to function_call items', () => {
      const chatResponse = {
        id: 'chatcmpl-2',
        model: 'gpt-4',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
      const result = chatToResponses(chatResponse);
      const fcItem = result.output.find((o) => o.type === 'function_call');
      assert.ok(fcItem);
      assert.strictEqual(fcItem.name, 'get_weather');
      assert.strictEqual(fcItem.arguments, '{"city":"NYC"}');
      assert.strictEqual(fcItem.call_id, 'call-1');
    });

    test('sets status to completed', () => {
      const chatResponse = {
        id: 'chatcmpl-3',
        model: 'gpt-4',
        choices: [{
          message: { content: 'Hello!' },
          finish_reason: 'stop',
        }],
      };
      const result = chatToResponses(chatResponse);
      assert.strictEqual(result.status, 'completed');
    });

    test('sets status to incomplete for finish_reason length', () => {
      const chatResponse = {
        id: 'chatcmpl-4',
        model: 'gpt-4',
        choices: [{
          message: { content: 'truncated...' },
          finish_reason: 'length',
        }],
      };
      const result = chatToResponses(chatResponse);
      assert.strictEqual(result.status, 'incomplete');
    });

    test('maps usage correctly', () => {
      const chatResponse = {
        id: 'chatcmpl-5',
        model: 'gpt-4',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      };
      const result = chatToResponses(chatResponse);
      assert.strictEqual(result.usage.input_tokens, 100);
      assert.strictEqual(result.usage.output_tokens, 50);
    });

    test('handles null chatResponse', () => {
      const result = chatToResponses(null, { model: 'gpt-4' });
      assert.strictEqual(result.object, 'response');
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.model, 'gpt-4');
      assert.deepStrictEqual(result.output, []);
    });
  });

  // --------------------------------------------------------------------------
  // 流式转换
  // --------------------------------------------------------------------------

  describe('Stream Conversion', () => {
    test('chatDeltaToResponsesEvents generates response.created on first chunk', () => {
      const state = makeStreamState();
      const chunk = {
        id: 'resp-1',
        model: 'gpt-4',
        choices: [{ delta: { content: 'Hello' } }],
      };
      const events = chatDeltaToResponsesEvents(chunk, state, {});
      const createdEvent = events.find((e) => e.type === 'response.created');
      assert.ok(createdEvent);
      assert.strictEqual(createdEvent.response.id, 'resp-1');
      assert.strictEqual(createdEvent.response.object, 'response');
      assert.strictEqual(createdEvent.response.status, 'in_progress');
      assert.strictEqual(state.responseCreated, true);
    });

    test('chatDeltaToResponsesEvents generates output_text.delta for content', () => {
      const state = makeStreamState();
      const chunk = {
        id: 'resp-1',
        model: 'gpt-4',
        choices: [{ delta: { content: 'Hello world' } }],
      };
      const events = chatDeltaToResponsesEvents(chunk, state, {});
      const deltaEvent = events.find((e) => e.type === 'response.output_text.delta');
      assert.ok(deltaEvent);
      assert.strictEqual(deltaEvent.delta, 'Hello world');
    });

    test('chatDeltaToResponsesEvents generates function_call_arguments.delta for tool calls', () => {
      const state = makeStreamState();
      const chunk = {
        id: 'resp-1',
        model: 'gpt-4',
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            }],
          },
        }],
      };
      const events = chatDeltaToResponsesEvents(chunk, state, {});
      const argDelta = events.find((e) => e.type === 'response.function_call_arguments.delta');
      assert.ok(argDelta);
      assert.strictEqual(argDelta.delta, '{"city":"NYC"}');
    });

    test('chatDeltaToResponsesEvents generates response.completed on finish', () => {
      const state = makeStreamState();
      // First chunk to start response
      const chunk1 = {
        id: 'resp-1',
        model: 'gpt-4',
        choices: [{ delta: { content: 'Hello' } }],
      };
      chatDeltaToResponsesEvents(chunk1, state, {});

      // Finish chunk
      const chunk2 = {
        choices: [{ finish_reason: 'stop' }],
      };
      const events = chatDeltaToResponsesEvents(chunk2, state, {});
      const completedEvent = events.find((e) => e.type === 'response.completed');
      assert.ok(completedEvent);
      assert.strictEqual(completedEvent.response.status, 'completed');
      assert.strictEqual(state.completed, true);
    });

    test('chatDeltaToResponsesEvents generates response.incomplete for finish_reason length', () => {
      const state = makeStreamState();
      const chunk1 = {
        id: 'resp-1',
        model: 'gpt-4',
        choices: [{ delta: { content: 'Hello' } }],
      };
      chatDeltaToResponsesEvents(chunk1, state, {});

      const chunk2 = {
        choices: [{ finish_reason: 'length' }],
      };
      const events = chatDeltaToResponsesEvents(chunk2, state, {});
      const incompleteEvent = events.find((e) => e.type === 'response.incomplete');
      assert.ok(incompleteEvent);
      assert.strictEqual(incompleteEvent.response.status, 'incomplete');
      assert.strictEqual(state.incomplete, true);
    });
  });

  // --------------------------------------------------------------------------
  // 事件检测
  // --------------------------------------------------------------------------

  describe('Event Detection', () => {
    test('isResponseCompleted detects response.completed', () => {
      assert.strictEqual(isResponseCompleted({ type: 'response.completed' }), true);
      assert.strictEqual(isResponseCompleted({ type: 'response.incomplete' }), false);
      assert.strictEqual(isResponseCompleted(null), false);
      assert.strictEqual(isResponseCompleted(undefined), false);
    });

    test('isResponseIncomplete detects response.incomplete', () => {
      assert.strictEqual(isResponseIncomplete({ type: 'response.incomplete' }), true);
      assert.strictEqual(isResponseIncomplete({ type: 'response.completed' }), false);
      assert.strictEqual(isResponseIncomplete(null), false);
      assert.strictEqual(isResponseIncomplete(undefined), false);
    });
  });

  // --------------------------------------------------------------------------
  // 错误响应
  // --------------------------------------------------------------------------

  describe('buildResponsesError', () => {
    test('creates error response', () => {
      const result = buildResponsesError({ message: 'Something failed', type: 'server_error' });
      assert.ok(result.error);
      assert.strictEqual(result.error.message, 'Something failed');
      assert.strictEqual(result.error.type, 'server_error');
    });

    test('maps auth_invalid to authentication_error', () => {
      const result = buildResponsesError({ message: 'bad key', type: 'auth_invalid' });
      assert.strictEqual(result.error.type, 'authentication_error');
    });

    test('maps rate_limit to rate_limit_exceeded', () => {
      const result = buildResponsesError({ message: 'too many requests', type: 'rate_limit_transient' });
      assert.strictEqual(result.error.type, 'rate_limit_exceeded');
    });

    test('handles null error', () => {
      const result = buildResponsesError(null);
      assert.strictEqual(result.error.message, 'An unexpected error occurred');
      assert.strictEqual(result.error.type, 'internal_error');
    });

    test('preserves error code', () => {
      const result = buildResponsesError({
        message: 'error',
        type: 'server_error',
        code: 'ERR_500',
      });
      assert.strictEqual(result.error.code, 'ERR_500');
    });
  });
});
