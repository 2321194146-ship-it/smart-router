import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
const CFG = path.join(TMP, 'c.json');
fs.writeFileSync(CFG, JSON.stringify({
  providers: { adapter: { display: 'A', base_url: 'http://adapter.test/v1', api_type: 'openai', keys: [{ api_key: 'k' }], responses_mode: 'chat-adapter' } },
  models: [{ id: 'resp-adapter', providers: ['adapter'], tier: 0 }],
  agents: [],
}));
process.env.CONFIG_FILE = CFG;
process.env.DB_PATH = path.join(TMP, 's.db');

const cfgMod = await import('./src/config.js');
cfgMod.reloadConfig();
const { getConfig } = cfgMod;
console.log('adminToken =', JSON.stringify(getConfig().adminToken));

const { createServer } = await import('./src/server.js');
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  text: async () => JSON.stringify({ model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  clone: function () { return this; },
});

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('listening', port);

const body = JSON.stringify({ model: 'resp-adapter', input: 'hello' });
const req = http.request(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let raw = '';
  res.on('data', (c) => (raw += c));
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('BODY', raw.slice(0, 300));
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
req.end(body);
