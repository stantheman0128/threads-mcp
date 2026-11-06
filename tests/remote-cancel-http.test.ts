import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ThreadsService } from '../src/service.js';
import { SearchIndex } from '../src/search.js';
import { getConfig } from '../src/config.js';
import { startRemoteHttp, RemoteReadDriver } from '../src/http-server.js';

const accountId = 'fixture', original = 'a'.repeat(43), replacement = 'b'.repeat(43);
const call = (client: Client, name: string, args: object) => client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
const unpack = (result: any): any => { assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent; };
const errorCode = (result: any) => JSON.parse(result.content[0].text).error;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'threads-cancel-http-'));
  const commands: any[] = [], clients: Client[] = [];
  let token = original, url = 'https://www.threads.com/', current: any, committed = false, commits = 0;
  let gate: Promise<void> | undefined, entered: (() => void) | undefined, release: (() => void) | undefined, holdBeforeEffect = false;
  const raw = {
    status: () => ({ connected: true, health: { state: 'connected', checkedAt: new Date().toISOString() } }), close: async () => {},
    command: async <T>(command: any, dispatchGuard?: () => void): Promise<T> => {
      commands.push(command);
      if (command.operation !== 'commit') dispatchGuard?.();
      if (command.type === 'read') return { url, viewer: { username: accountId }, posts: [], profiles: [], replies: [], warnings: [], observedAt: new Date().toISOString(), composerState: { present: false, nonempty: false, attachments: false, ambiguous: false } } as T;
      if (command.type === 'navigate') { url = command.url; return { url } as T; }
      if (command.type === 'social') {
        if (command.operation === 'stage') {
          current = structuredClone(command.request); committed = false;
          return { token: randomUUID(), account: accountId, url, request: current, noop: false, before: { account: accountId, url, targetUrl: current.targetUrl, verified: false, state: 'draft', evidence: [] } } as T;
        }
        if (command.operation === 'commit') {
          if (gate && holdBeforeEffect) { entered!(); await gate; gate = undefined; }
          dispatchGuard?.();
          commits++;
          if (gate) { entered!(); await gate; gate = undefined; }
          committed = true; url = `https://www.threads.com/@${accountId}/post/P${commits}`;
          return { dispatched: true, noop: false } as T;
        }
        if (command.operation === 'inspect') return { account: accountId, url, targetUrl: current.targetUrl, verified: committed, state: committed ? 'published' : 'draft', postUrl: committed ? url : undefined, evidence: ['Isolated fixture publication matched.'] } as T;
      }
      throw new Error('Unexpected fixture browser command');
    },
  };
  const service = new ThreadsService(new RemoteReadDriver(raw), new SearchIndex(dir), { ...getConfig(), dataDir: dir, writesEnabled: true, minActionIntervalMs: 0 });
  const http = await startRemoteHttp(service, { port: 0, readToken: () => token, controlledWrites: true, socialDriver: raw, capabilities: { schedule: true } });
  const endpoint = new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`);
  const connect = async () => {
    const client = new Client({ name: 'cancel-http-fixture', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return client;
  };
  const client = await connect();
  const post = async (body: unknown, bearer = token) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const health = async (bearer = token) => {
    const response = await fetch(new URL('/healthz', endpoint), { headers: { Authorization: `Bearer ${bearer}` } });
    return { status: response.status, body: await response.json() as any };
  };
  const cancel = (id: string, account = accountId, bearer = token, extra: object = {}) => post({ jsonrpc: '2.0', id: 'cancel', method: 'tools/call', params: { name: 'threads_cancel_schedule', arguments: { accountId: account, id, ...extra } } }, bearer);
  const ordinary = (bearer = token) => post({ jsonrpc: '2.0', id: 'status', method: 'tools/call', params: { name: 'threads_status', arguments: {} } }, bearer);
  return { client, connect, commands, post, health, cancel, ordinary, get commits() { return commits; },
    rotate: () => { token = replacement; },
    holdCommit: (beforeEffect = false) => { holdBeforeEffect = beforeEffect; const ready = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { release = resolve; }); return { ready, release: () => release!() }; },
    close: async () => { release?.(); for (const client of clients) await client.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await service.close(); assert.equal(dirname(dir), tmpdir()); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function authorize(client: Client, parts = 2) {
  const ids = [];
  for (let index = 0; index < parts; index++) ids.push(unpack(await call(client, 'threads_save_draft', { accountId, draft: { text: `Fixture chain part ${index + 1}` } })).id);
  const job = unpack(await call(client, 'threads_stage_schedule', { accountId, draftIds: ids, at: '2020-01-01T00:00:00Z' }));
  unpack(await call(client, 'threads_authorize_schedule', { accountId, id: job.id })); return job;
}

test('HTTP busy cancel preserves the lock, rejects unrelated calls and stops the next part without extra browser dispatch', async () => {
  const f = await fixture(); let pending: ReturnType<typeof call> | undefined; let release: (() => void) | undefined;
  try {
    const job = await authorize(f.client); const hold = f.holdCommit(); release = hold.release;
    pending = call(f.client, 'threads_run_schedules', { accountId }); await hold.ready;
    const before = f.commands.length;
    assert.equal((await f.ordinary()).status, 429);
    assert.equal((await f.cancel(job.id, accountId, 'x'.repeat(43))).status, 401);
    for (const response of [await f.cancel(job.id, 'another'), await f.cancel(randomUUID()), await f.cancel(job.id, accountId, original, { unexpected: true })]) {
      assert.equal(response.status, 200); assert.equal(response.body.result.isError, true);
      assert.ok(['SCHEDULE_NOT_RUNNING', 'INVALID_WORKFLOW'].includes(errorCode(response.body.result)));
    }
    assert.equal((await f.post([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'threads_cancel_schedule', arguments: { accountId, id: job.id } } }])).status, 400);
    assert.equal((await f.health()).body.busy, true); assert.equal((await f.ordinary()).status, 429);
    assert.equal(f.commands.length, before);
    const cancel = await f.cancel(job.id); assert.equal(cancel.status, 200); assert.equal(unpack(cancel.body.result).cancelRequested, true);
    assert.equal(f.commands.length, before); assert.equal((await f.health()).body.busy, true); assert.equal((await f.ordinary()).status, 429);
    hold.release(); const result = unpack(await pending);
    assert.equal(result.jobs[0].status, 'cancelled'); assert.equal(result.jobs[0].parts[0].status, 'confirmed'); assert.equal(result.jobs[0].parts[1].status, 'pending');
    assert.equal(f.commits, 1); assert.equal(f.commands.filter(command => command.operation === 'stage').length, 1);
    assert.equal((await f.health()).body.busy, false);
    const status = unpack(await call(f.client, 'threads_status', {})); assert.equal(status.capabilities.schedule, true); assert.equal(status.writesEnabled, true);
    assert.equal(unpack(await call(f.client, 'threads_run_schedules', { accountId })).jobs.length, 0);
  } finally { release?.(); await pending?.catch(() => undefined); await f.close(); }
});

test('HTTP new credentials cannot commandeer a busy run or release its lock; fresh epoch works after uncertain completion', async () => {
  const f = await fixture(); let pending: ReturnType<typeof call> | undefined; let release: (() => void) | undefined;
  try {
    const job = await authorize(f.client); const hold = f.holdCommit(); release = hold.release;
    pending = call(f.client, 'threads_run_schedules', { accountId }); await hold.ready;
    const before = f.commands.length; f.rotate();
    const response = await f.cancel(job.id, accountId, replacement);
    assert.equal(response.status, 200); assert.equal(response.body.result.isError, true); assert.equal(errorCode(response.body.result), 'ACCESS_CHANGED');
    assert.equal((await f.cancel(job.id, accountId, original)).status, 401);
    assert.equal((await f.ordinary(replacement)).status, 429); assert.equal((await f.health(replacement)).body.busy, true);
    assert.equal(f.commands.length, before); assert.equal(f.commits, 1);
    hold.release(); const result = unpack(await pending);
    assert.equal(result.jobs[0].status, 'uncertain'); assert.equal(result.jobs[0].parts[1].status, 'pending'); assert.equal(f.commits, 1);
    assert.equal((await f.health(replacement)).body.busy, false);
    const client = await f.connect(); assert.equal(unpack(await call(client, 'threads_run_schedules', { accountId })).jobs.length, 0);
    const fresh = await authorize(client, 1); const next = unpack(await call(client, 'threads_run_schedules', { accountId }));
    assert.equal(next.jobs.length, 1); assert.equal(next.jobs[0].id, fresh.id); assert.equal(next.jobs[0].status, 'confirmed'); assert.equal(f.commits, 2);
    assert.equal(unpack(await call(client, 'threads_status', {})).capabilities.schedule, true);
  } finally { release?.(); await pending?.catch(() => undefined); await f.close(); }
});

test('HTTP cancellation during native commit preflight prevents the first effect and never replays either chain part', async () => {
  const f = await fixture(); let pending: ReturnType<typeof call> | undefined; let release: (() => void) | undefined;
  try {
    const job = await authorize(f.client); const hold = f.holdCommit(true); release = hold.release;
    pending = call(f.client, 'threads_run_schedules', { accountId }); await hold.ready;
    assert.equal(f.commits, 0);
    const before = f.commands.length; const cancel = await f.cancel(job.id);
    assert.equal(cancel.status, 200); assert.equal(unpack(cancel.body.result).cancelRequested, true); assert.equal(f.commands.length, before);
    assert.equal((await f.health()).body.busy, true); assert.equal((await f.ordinary()).status, 429);
    hold.release(); const result = unpack(await pending);
    assert.equal(result.jobs[0].status, 'uncertain'); assert.equal(result.jobs[0].parts[0].status, 'uncertain'); assert.equal(result.jobs[0].parts[1].status, 'pending');
    assert.equal(f.commits, 0); assert.equal(f.commands.filter(command => command.operation === 'stage').length, 1);
    assert.equal(unpack(await call(f.client, 'threads_run_schedules', { accountId })).jobs.length, 0); assert.equal(f.commits, 0);
    assert.equal((await f.health()).body.busy, false);
  } finally { release?.(); await pending?.catch(() => undefined); await f.close(); }
});
