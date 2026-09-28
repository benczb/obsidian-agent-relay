// Run against the built image with no host mounts, network or published ports:
// docker run --rm -i --network none --read-only --tmpfs /fixture:rw,mode=1777 --entrypoint node obsidian-agent-relay:audit-local --input-type=module < test/container-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.getuid(), 1000);
await mkdir('/fixture/notes');
const token = 'container-test-private-'.repeat(3);
const restToken = 'container-test-rest-'.repeat(3);
const common = { PATH: process.env.PATH, HOST: '127.0.0.1', KANBAN_BOARD_PATH: '/fixture/board.md' };
const children = [];
const start = (entry, env) => {
  const child = spawn(process.execPath, [`dist/src/${entry}.js`], { env: { ...common, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(child);
};
async function ready(base) {
  for (let i = 0; i < 100; i++) {
    if (children.some(child => child.exitCode !== null)) throw new Error('Service exited during startup');
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await delay(50);
  }
  throw new Error('Startup timeout');
}
async function mcp(base, bearer, name, args) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: ')).slice(6) : text);
  assert.ok(!payload.error && !payload.result.isError, text);
  return JSON.parse(payload.result.content[0].text);
}
try {
  start('index', { PORT: '17877', MCP_BEARER_TOKEN: token, PUBLIC_BASE_URL: 'https://audit.example.test', OAUTH_HOST: '127.0.0.1', OAUTH_PORT: '17879', OAUTH_OWNER_TOKEN: 'container-test-owner-'.repeat(3), OAUTH_STATE_DIR: '/fixture/oauth' });
  start('rest-facade', { PORT: '17878', REST_BEARER_TOKEN: restToken, OBSIDIAN_VAULT_PATH: '/fixture/notes' });
  const privateBase = 'http://127.0.0.1:17877', restBase = 'http://127.0.0.1:17878', oauthBase = 'http://127.0.0.1:17879';
  await Promise.all([privateBase, restBase, oauthBase].map(ready));
  assert.equal((await fetch(`${restBase}/v1/cards`)).status, 401);
  assert.equal((await fetch(`${oauthBase}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${oauthBase}/.well-known/oauth-authorization-server`)).status, 200);
  const card = await mcp(privateBase, token, 'add_task', { title: 'Container fixture', from: 'chatgpt', to: 'hermes', thread: 'container-only' });
  const read = await fetch(`${restBase}/v1/cards/${card.id}`, { headers: { Authorization: `Bearer ${restToken}` } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).card.thread, 'container-only');
  await mcp(privateBase, token, 'claim_task', { id: card.id, agent: 'hermes' });
  await mcp(privateBase, token, 'complete_task', { id: card.id, agent: 'hermes', result: 'Container ACK' });
  assert.equal((await mcp(privateBase, token, 'get_task', { id: card.id })).result, 'Container ACK');
  const note = await fetch(`${restBase}/v1/vault/note`, { method: 'POST', headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Proof.md', markdown: 'Fixture only' }) });
  assert.equal(note.status, 201);
  const contents = await fetch(`${restBase}/v1/vault/note?path=Proof.md`, { headers: { Authorization: `Bearer ${restToken}` } });
  assert.equal(await contents.text(), 'Fixture only');
  console.log('PASS: non-root read-only Docker image; MCP/REST shared board; OAuth startup/metadata/auth isolation; note round trip');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
}
