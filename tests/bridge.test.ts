import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { BridgeServer, isThreadsUrl } from '../src/bridge.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
async function setup(commandTimeoutMs = 1000, authTimeoutMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'threads-bridge-'));
  const bridge = new BridgeServer({ dataDir: dir, port: 0, commandTimeoutMs, authTimeoutMs });
  await bridge.start();
  const pairing = JSON.parse(readFileSync(join(dir, 'bridge-pairing.json'), 'utf8')) as { token: string; port: number };
  return { bridge, pairing, dir, cleanup: async () => { await bridge.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function socket(port: number, wsOrigin = origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: wsOrigin });
  ws.on('error', () => undefined);
  await once(ws, 'open');
  return ws;
}
async function authenticated(port: number, token: string) {
  const ws = await socket(port);
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'auth', token, tab: { id: 42, url: 'https://www.threads.com/@sample', title: 'Threads' } }));
  assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
  return ws;
}

test('authenticated extension has correlated command replies without exposing token in status', async () => {
  const { bridge, pairing, cleanup } = await setup();
  try {
    const ws = await authenticated(pairing.port, pairing.token);
    assert.equal(bridge.status().connected, true);
    assert.ok(!JSON.stringify(bridge.status()).includes(pairing.token));
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.command) ws.send(JSON.stringify({ id: message.id, result: { posts: ['fixture'] } }));
    });
    assert.deepEqual(await bridge.command({ type: 'read' }), { posts: ['fixture'] });
  } finally { await cleanup(); }
});

test('missing authentication and wrong tokens are rejected', async () => {
  const { bridge, pairing, cleanup } = await setup(1000, 40);
  try {
    const anonymous = await socket(pairing.port);
    const [code] = await once(anonymous, 'close');
    assert.equal(code, 1008);
    assert.equal(bridge.status().connected, false);
    const wrong = await socket(pairing.port);
    const closed = once(wrong, 'close');
    wrong.send(JSON.stringify({ type: 'auth', token: '0'.repeat(64), tab: { id: 42, url: 'https://www.threads.com/' } }));
    assert.equal((await closed)[0], 1008);
  } finally { await cleanup(); }
});

test('standalone bridge validates and forwards bounded direct profile reads exactly once', async () => {
  const { bridge, pairing, cleanup } = await setup();
  try {
    const ws = await authenticated(pairing.port, pairing.token);
    const received: unknown[] = [];
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.command) { received.push(message.command); ws.send(JSON.stringify({ id: message.id, result: { posts: [], partial: true } })); }
    });
    const command = { type: 'direct_profile', username: 'fixture', maxPages: 5, pageSize: 20 };
    assert.deepEqual(await bridge.command(command), { posts: [], partial: true });
    for (const invalid of [{ ...command, url: 'https://example.test' }, { ...command, username: '../x' }, { ...command, maxPages: 6 }])
      await assert.rejects(bridge.command(invalid), { code: 'INVALID_COMMAND' });
    assert.deepEqual(received, [command]);
  } finally { await cleanup(); }
});

test('ordinary web origins cannot upgrade even with the right token', async () => {
  const { pairing, cleanup } = await setup();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/bridge`, { origin: 'https://www.threads.com' });
    ws.on('error', () => undefined);
    const status = await new Promise<number | undefined>(resolve => ws.once('unexpected-response', (_req, response) => { resolve(response.statusCode); response.resume(); ws.terminate(); }));
    assert.equal(status, 403);
  } finally { await cleanup(); }
});

test('disconnect rejects pending commands and does not preserve work for a later connection', async () => {
  const { bridge, pairing, cleanup } = await setup();
  try {
    const ws = await authenticated(pairing.port, pairing.token);
    const incoming = once(ws, 'message');
    const result = bridge.command({ type: 'read' });
    const rejected = assert.rejects(result, { code: 'BRIDGE_DISCONNECTED' });
    await incoming;
    ws.close();
    await rejected;
    assert.equal(bridge.status().connected, false);
    await assert.rejects(bridge.command({ type: 'read' }), { code: 'BRIDGE_NOT_CONNECTED' });
  } finally { await cleanup(); }
});

test('timeout reports unknown outcome, never resends, and ignores a late reply', async () => {
  const { bridge, pairing, cleanup } = await setup(35);
  try {
    const ws = await authenticated(pairing.port, pairing.token);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(String(data))));
    await assert.rejects(bridge.command({ type: 'interact', snapshotId: 's1', ref: 'r1', verb: 'click' }), { code: 'BRIDGE_TIMEOUT' });
    assert.equal(messages.length, 1);
    ws.send(JSON.stringify({ id: messages[0].id, result: { completed: true } }));
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.command?.type === 'read') ws.send(JSON.stringify({ id: message.id, result: 'new result' }));
    });
    assert.equal(await bridge.command({ type: 'read' }), 'new result');
    assert.equal(messages.filter(message => message.command?.type === 'interact').length, 1);
  } finally { await cleanup(); }
});

test('command allowlist rejects unsafe URLs, unknown verbs and arbitrary execution', async () => {
  const { bridge, cleanup } = await setup();
  try {
    await assert.rejects(bridge.command({ type: 'evaluate', code: 'alert(1)' }), { code: 'INVALID_COMMAND' });
    await assert.rejects(bridge.command({ type: 'navigate', url: 'https://threads.com.attacker.example/' }), { code: 'INVALID_URL' });
    await assert.rejects(bridge.command({ type: 'navigate', url: 'https://user:password@threads.com/' }), { code: 'INVALID_URL' });
    await assert.rejects(bridge.command({ type: 'scroll', pixels: Infinity }), { code: 'INVALID_COMMAND' });
    await assert.rejects(bridge.command({ type: 'interact', snapshotId: 'a', ref: 'b', verb: 'evaluate' }), { code: 'INVALID_COMMAND' });
    assert.equal(isThreadsUrl('https://www.threads.net/@sample'), true);
    assert.equal(isThreadsUrl('http://threads.com/'), false);
    assert.equal(isThreadsUrl('https://threads.com:9999/'), false);
  } finally { await cleanup(); }
});

test('wrong tab URL cannot authenticate and leaving Threads disconnects', async () => {
  const { bridge, pairing, cleanup } = await setup();
  try {
    const wrong = await socket(pairing.port);
    const closed = once(wrong, 'close');
    wrong.send(JSON.stringify({ type: 'auth', token: pairing.token, tab: { id: 1, url: 'https://example.com/' } }));
    assert.equal((await closed)[0], 1008);
    const ws = await authenticated(pairing.port, pairing.token);
    const disconnected = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'tab', tab: { id: 42, url: 'https://example.com/' } }));
    assert.equal((await disconnected)[0], 1008);
    assert.equal(bridge.status().connected, false);
  } finally { await cleanup(); }
});

test('only one tab can bind and a different tab id is not accepted as an update', async () => {
  const { bridge, pairing, cleanup } = await setup();
  try {
    const first = await authenticated(pairing.port, pairing.token);
    const second = await socket(pairing.port);
    const denied = once(second, 'close');
    second.send(JSON.stringify({ type: 'auth', token: pairing.token, tab: { id: 43, url: 'https://www.threads.com/' } }));
    assert.equal((await denied)[0], 1008);
    assert.equal(bridge.status().tab?.id, 42);
    const closed = once(first, 'close');
    first.send(JSON.stringify({ type: 'tab', tab: { id: 43, url: 'https://www.threads.com/' } }));
    assert.equal((await closed)[0], 1008);
  } finally { await cleanup(); }
});

test('pairing page has no-store CSP and rejects DNS rebinding host headers', async () => {
  const { pairing, cleanup } = await setup();
  try {
    const response = await fetch(`http://127.0.0.1:${pairing.port}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'none'"));
    assert.ok((await response.text()).includes(pairing.token));
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: pairing.port, path: '/', headers: { host: 'attacker.example' } }, response => { resolve(response.statusCode); response.resume(); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    const crossSite = await fetch(`http://127.0.0.1:${pairing.port}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
  } finally { await cleanup(); }
});
