import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { BridgeServer } from '../src/bridge.js';
import { RemoteExtensionDriver } from '../src/remote-driver.js';
import { ThreadsError } from '../src/types.js';

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

test('fresh health recovers bridge restart and token rotation without replaying a failed command', async () => {
  const { dataDir, host, remote, pairing, cleanup } = await setup();
  let replacement: BridgeServer | undefined;
  let closing: Promise<void> | undefined;
  let dispatched = 0;
  try {
    assert.deepEqual(remote.status().health, { state: 'unchecked', checkedAt: null });
    const ws = await extension(pairing);
    ws.on('message', data => {
      const message = JSON.parse(String(data)); if (!message.command) return;
      dispatched++;
      // Close the actual bridge after accepting the command, before any browser reply.
      closing = host.close();
    });
    await assert.rejects(remote.command({ type: 'interact', snapshotId: 's', ref: 'r', verb: 'click' }), { code: 'BRIDGE_DISCONNECTED' });
    await closing;
    assert.equal(dispatched, 1);
    assert.equal((await remote.refreshStatus()).connected, false);
    assert.equal((remote.status().health as any).state, 'pairing-missing');

    replacement = new BridgeServer({ dataDir, port: pairing.port, commandTimeoutMs: 1000 });
    await replacement.start();
    const nextPairing = JSON.parse(readFileSync(join(dataDir, 'bridge-pairing.json'), 'utf8'));
    assert.notEqual(nextPairing.token, pairing.token);
    assert.equal((await remote.refreshStatus()).connected, false);
    assert.equal((remote.status().health as any).state, 'extension-disconnected');
    await assert.rejects(remote.command({ type: 'read' }), { code: 'BRIDGE_NOT_CONNECTED' });
    assert.equal(dispatched, 1);
    const nextWs = await extension(nextPairing);
    const kinds: string[] = [];
    nextWs.on('message', data => {
      const message = JSON.parse(String(data)); if (!message.command) return;
      dispatched++; kinds.push(message.command.type);
      nextWs.send(JSON.stringify({ id: message.id, result: { recovered: true } }));
    });
    // The same driver recovers on the next explicit read, without a connect() call.
    assert.deepEqual(await remote.command({ type: 'read' }), { recovered: true });
    assert.deepEqual(kinds, ['read']); assert.equal(dispatched, 2);
    const status = await remote.refreshStatus();
    assert.equal(status.connected, true); assert.equal((status.health as any).state, 'connected');
    assert.ok(Number.isFinite(Date.parse((status.health as any).checkedAt)));
    assert.equal(dispatched, 2, 'health must not send any browser command');
    assert.ok(!JSON.stringify(status).includes(nextPairing.token));
    await remote.close(); assert.equal((remote.status().health as any).state, 'closed');
    assert.equal(replacement.status().connected, true, 'closing the client preserves the paired extension');
  } finally { await closing; await replacement?.close(); await cleanup(); }
});

test('refresh health clears stale identity and distinguishes missing pairing, auth failure and unreachable host', async () => {
  const { dataDir, host, remote, pairing, cleanup } = await setup();
  try {
    await extension(pairing); await remote.connect(); assert.equal(remote.status().connected, true);
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify({ ...pairing, token: '0'.repeat(64) }));
    const unauthorized = await remote.refreshStatus();
    assert.equal((unauthorized.health as any).state, 'auth-failed');
    assert.equal(unauthorized.connected, false); assert.equal(unauthorized.tab, null);
    assert.equal((unauthorized.health as any).errorCode, 'BRIDGE_AUTH_FAILED');
    writeFileSync(join(dataDir, 'bridge-pairing.json'), 'broken');
    assert.equal(((await remote.refreshStatus()).health as any).state, 'pairing-invalid');
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify(pairing));
    await host.close();
    assert.equal(((await remote.refreshStatus()).health as any).state, 'pairing-missing');
    writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify(pairing));
    const unavailable = await remote.refreshStatus();
    assert.equal((unavailable.health as any).state, 'host-unreachable');
    assert.equal((unavailable.health as any).errorCode, 'ECONNREFUSED');
    assert.ok(!JSON.stringify(unavailable).includes(pairing.token));
  } finally { await cleanup(); }
});

test('dispatch guard rechecks access after a delayed native status response and never serializes or retries it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'threads-dispatch-guard-'));
  const requests: string[] = [];
  const bodies: string[] = [];
  let releaseStatus!: () => void;
  let reachedStatus!: () => void;
  const statusGate = new Promise<void>(resolve => { releaseStatus = resolve; });
  const statusReached = new Promise<void>(resolve => { reachedStatus = resolve; });
  let firstStatus = true;
  let port = 0;
  const status = () => ({ connected: true, running: true, port, pairingUrl: `http://127.0.0.1:${port}/`, tab: { id: 55, url: 'https://www.threads.com/' } });
  const host = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const send = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/status') {
      if (firstStatus) {
        firstStatus = false; reachedStatus();
        void statusGate.then(() => send({ status: status() }));
      } else send({ status: status() });
      return;
    }
    let body = '';
    req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => { bodies.push(body); send({ status: status(), result: { accepted: true } }); });
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  port = (host.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify({ port, token: 'b'.repeat(64) }));
  const remote = new RemoteExtensionDriver({ dataDir, healthTimeoutMs: 2000 });
  let allowed = true;
  let guardCalls = 0;
  const guard = () => { guardCalls++; if (!allowed) throw new ThreadsError('ACCESS_CHANGED', 'Access changed.'); };
  try {
    const pending = remote.command({ type: 'read' }, guard);
    const rejected = assert.rejects(pending, { code: 'ACCESS_CHANGED' });
    await statusReached;
    assert.equal(guardCalls, 1);
    allowed = false; releaseStatus(); await rejected;
    assert.equal(guardCalls, 2);
    assert.deepEqual(requests, ['GET /status']);
    assert.deepEqual(bodies, []);

    allowed = true;
    assert.deepEqual(await remote.command({ type: 'read' }, guard), { accepted: true });
    assert.equal(guardCalls, 4);
    assert.deepEqual(requests, ['GET /status','GET /status','POST /command']);
    assert.deepEqual(bodies, ['{"type":"read"}']);

    allowed = false;
    await assert.rejects(remote.command({ type: 'read' }, guard), { code: 'ACCESS_CHANGED' });
    assert.equal(guardCalls, 5);
    assert.equal(requests.length, 3, 'initial rejection performs no native preflight or command');
  } finally {
    releaseStatus(); await remote.close(); host.closeAllConnections();
    await new Promise<void>(resolve => host.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('health timeout is bounded, emits no browser command and never substitutes stale success', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'threads-health-timeout-'));
  const requests: string[] = [];
  const host = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); // Headers arrive; body never completes.
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  const port = (host.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'bridge-pairing.json'), JSON.stringify({ port, token: 'a'.repeat(64) }));
  const remote = new RemoteExtensionDriver({ dataDir, healthTimeoutMs: 40 });
  try {
    const status = await remote.refreshStatus();
    assert.equal((status.health as any).state, 'host-unreachable');
    assert.equal((status.health as any).errorCode, 'BRIDGE_HEALTH_TIMEOUT');
    assert.equal(status.connected, false);
    await assert.rejects(remote.command({ type: 'read' }), { code: 'BRIDGE_HEALTH_TIMEOUT' });
    assert.deepEqual(requests, ['/status', '/status']);
  } finally {
    await remote.close(); host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
