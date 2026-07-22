/**
 * Test helpers — mock Response factory and provider configs
 */

export function mockResponse(body, status = 200, headers = {}) {
  const text = () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
  const json = () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body);
  const clone = () => mockResponse(body, status, headers);

  const streamBody = typeof body === 'string' ? body : JSON.stringify(body);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(streamBody));
      controller.close();
    }
  });

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text,
    json,
    clone,
    body: stream,
  };
}

export function mockSSEResponse(events, status = 200) {
  const data = events.map(e => {
    if (e === '[DONE]') return 'data: [DONE]\n\n';
    return `data: ${JSON.stringify(e)}\n\n`;
  }).join('');
  return mockResponse(data, status, { 'content-type': 'text/event-stream' });
}

export function providerConfig(name = 'test-provider') {
  return {
    base_url: 'https://api.test.com/v1',
    api_key: 'sk-test-key-abc123def456',
    display: name,
    api_type: 'openai',
    enabled: true,
  };
}

export function modelConfig(id, provider, tier = 0) {
  return { id, name: id, provider, enabled: true, tier };
}

export const testConfig = {
  port: 0,
  host: '127.0.0.1',
  adminToken: '',
  providers: {
    'test-provider': providerConfig('test-provider'),
    'test-provider-2': providerConfig('test-provider-2'),
  },
  models: [
    modelConfig('gpt-4o', 'test-provider'),
    modelConfig('gpt-4o-mini', 'test-provider'),
    modelConfig('claude-sonnet-4', 'test-provider-2'),
  ],
  routing: {
    tierWeights: { 0: 50, 1: 50 },
    maxRetries: 4,
    perModelTimeoutMs: 5000,
    cooldownSeconds: 1,
    failureThreshold: 3,
  },
  roles: {
    fast: ['gpt-4o-mini'],
    primary: ['gpt-4o', 'claude-sonnet-4'],
  },
  system_prompt: '',
  disable_prompt_injection: true,
  claude_code_mode: 'experimental-non-claude-routing',
};
