import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { BridgeServer } from '../src/bridge.js';
import { RemoteExtensionDriver } from '../src/remote-driver.js';

async function setup(timeout = 1000) {
  const dataDir = mkdtempSync(join(tmpdir(), 'threads-remote-'));
  const host = new BridgeServer({ dataDir, port: 0, commandTimeoutMs: timeout });
  await host.start();
  const pairing = JSON.parse(readFileSync(join(dataDir, 'bridge-pairing.json'), 'utf8')) as { port: number; token: string };
  const remote = new RemoteExtensionDriver({ dataDir, requestTimeoutMs: 2000 });
  const headers = { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${pairing.port}`;
  return { dataDir, host, remote, pairing, headers, base, cleanup: async () => { await remote.close(); await host.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
async function extension(pairing: { port: number; token: string }) {
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/bridge`, { origin: `chrome-extension://${'b'.repeat(32)}` });
  ws.on('error', () => undefined);
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'auth', token: pairing.token, tab: { id: 55, url: 'https://www.threads.com/@fixture' } }));
  await ready;
  return ws;
}

test('remote attaches before pairing, refreshes status and reads through an authenticated extension', async () => {
  const { host, remote, pairing, cleanup } = await setup();
  try {
    await remote.connect();
    assert.equal(remote.status().connected, false);
    const ws = await extension(pairing);
    await remote.connect();
    assert.equal(remote.status().connected, true);
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.command) ws.send(JSON.stringify({ id: message.id, result: { posts: [{ id: 'fixture', likes: 193 }] } }));
    });
    assert.deepEqual(await remote.command({ type: 'read' }), { posts: [{ id: 'fixture', likes: 193 }] });
    assert.equal(remote.status().remote, true);
    assert.ok(!JSON.stringify(remote.status()).includes(pairing.token));
    await remote.close();
    assert.equal(host.status().running, true);
    assert.equal(host.status().connected, true);
    assert.deepEqual(await host.command({ type: 'read' }), { posts: [{ id: 'fixture', likes: 193 }] });
  } finally { await cleanup(); }
});

test('RPC requires bearer authentication, absent Origin, correct method and bounded JSON object', async () => {
  const { base, headers, pairing, cleanup } = await setup();
  try {
    const missing = await fetch(`${base}/status`);
    assert.equal(missing.status, 401);
    assert.ok(!(await missing.text()).includes(pairing.token));
    assert.equal((await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: { ...headers, Origin: base } })).status, 403);
    assert.equal((await fetch(`${base}/command`, { headers })).status, 405);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: 'not json' })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: '[]' })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ type: 'evaluate' }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ type: 'navigate', url: 'https://example.com' }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ type: 'read', extra: 'x'.repeat(65536) }) })).status, 413);
    const status = await fetch(`${base}/status`, { headers });
    assert.equal(status.status, 200);
    assert.ok(!(await status.text()).includes(pairing.token));
  } finally { await cleanup(); }
});

test('remote distinguishes missing pairing, authentication failure and invalid configured port', async () => {
  const { dataDir, remote, pairing, cleanup } = await setup();
  try {
    const missing = new RemoteExtensionDriver({ dataDir: join(dataDir, 'missing') });
    await assert.rejects(missing.connect(), { code: 'BRIDGE_PAIRING_MISSING' });
    const mismatch = new RemoteExtensionDriver({ dataDir, port: pairing.port + 1 });
    await assert.rejects(mismatch.connect(), { code: 'BRIDGE_PAIRING_INVALID' });
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify({ ...pairing, token: '0'.repeat(64) }));
    await assert.rejects(remote.connect(), { code: 'BRIDGE_AUTH_FAILED' });
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify({ port: 'http://evil.example', token: pairing.token }));
    await assert.rejects(remote.connect(), { code: 'BRIDGE_PAIRING_INVALID' });
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify(pairing));
  } finally { await cleanup(); }
});

test('remote refuses closed host without swallowing ECONNREFUSED', async () => {
  const { dataDir, host, remote, pairing, cleanup } = await setup();
  try {
    await host.close();
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify(pairing));
    await assert.rejects(remote.connect(), { code: 'ECONNREFUSED' });
  } finally { await cleanup(); }
});

test('RPC command timeout is not retried and page error text is sanitized', async () => {
  const { remote, pairing, cleanup } = await setup(40);
  try {
    const ws = await extension(pairing);
    await remote.connect();
    let requests = 0;
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (!message.command) return;
      requests++;
      if (message.command.type === 'read') ws.send(JSON.stringify({ id: message.id, error: { code: 'STALE_SNAPSHOT', message: `private page text ${pairing.token}` } }));
    });
    await assert.rejects(remote.command({ type: 'interact', snapshotId: 's', ref: 'r', verb: 'click' }), { code: 'BRIDGE_TIMEOUT' });
    assert.equal(requests, 1);
    await assert.rejects(remote.command({ type: 'read' }), error => {
      assert.equal((error as { code: string }).code, 'STALE_SNAPSHOT');
      assert.ok(!String(error).includes(pairing.token));
      assert.ok(!String(error).includes('private page text'));
      return true;
    });
    assert.equal(requests, 2);
  } finally { await cleanup(); }
});
