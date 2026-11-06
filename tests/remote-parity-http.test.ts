import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { BrowserDriver } from '../src/driver.js';
import type { RemoteCapabilities } from '../src/remote-capabilities.js';
import { RemoteReadDriver, startRemoteHttp } from '../src/http-server.js';
import { ThreadsService } from '../src/service.js';
import { SearchIndex } from '../src/search.js';
import type { Post } from '../src/types.js';

const capabilityKeys = ['extendedReads', 'delete', 'schedule', 'browserFallback', 'messages', 'officialApi'] as const;
const baseTools = ['threads_status', 'threads_search', 'threads_research', 'threads_my_activity', 'threads_find_mentions', 'threads_get_post', 'threads_get_post_activity', 'threads_get_replies', 'threads_get_profile', 'threads_get_connections', 'threads_check_relationship', 'threads_search_users', 'threads_discover', 'threads_reply_inbox', 'threads_batch_read'];
const groups = {
  extendedReads: ['threads_get_notifications', 'threads_get_feed', 'threads_collect', 'threads_trends', 'threads_observed_analytics'],
  delete: ['threads_prepare_confirmation', 'threads_execute_confirmation'],
  schedule: ['threads_save_draft', 'threads_list_drafts', 'threads_delete_draft', 'threads_stage_schedule', 'threads_list_schedules', 'threads_authorize_schedule', 'threads_cancel_schedule', 'threads_run_schedules', 'threads_reconcile_schedule'],
  browserFallback: ['threads_browser_snapshot', 'threads_browser_scroll', 'threads_prepare_action', 'threads_execute_action'],
  messages: ['threads_get_messages'],
  officialApi: ['threads_api_status', 'threads_api_read', 'threads_api_prepare', 'threads_api_execute'],
};
const socialTools = ['threads_inspect_social', 'threads_prepare_social', 'threads_execute_social'];
const allCapabilities = Object.fromEntries(capabilityKeys.map(key => [key, true])) as RemoteCapabilities;
const privatePost: Post = {
  id: 'private-fixture-post', url: 'https://www.threads.com/@fixture/post/PRIVATE', author: { username: 'fixture' }, text: 'SYNTHETIC_PRIVATE_POST',
  createdAt: null, likes: null, replies: null, reposts: null, quotes: null, views: null, isReply: null, parentId: null, rootId: null,
  media: [], observedAt: '2026-11-06T00:00:00Z', source: 'browser-dom',
};

async function fixture(options: { writes?: boolean; media?: boolean; capabilities?: Partial<RemoteCapabilities> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'threads-parity-http-'));
  let token = randomBytes(32).toString('base64url'), viewer = 'fixture', url = 'https://www.threads.com/';
  const commands: Record<string, unknown>[] = [], clients: Client[] = [];
  const raw: BrowserDriver = {
    status: () => ({ connected: true }), close: async () => {},
    command: async <T>(command: Record<string, unknown>): Promise<T> => {
      commands.push(structuredClone(command));
      if (command.type === 'navigate') { url = command.url as string; return { url } as T; }
      if (command.type === 'remote_view') { url='https://www.threads.com'+({for_you:'/',following:'/following/',saved:'/saved/',liked:'/liked/',notifications:'/activity',messages:'/messages/'} as any)[String(command.kind)];return {dispatched:true} as T; }
      if (command.type === 'scroll') return {} as T;
      if (command.type === 'read') return {remoteNavigationToken:'00000000-0000-4000-8000-000000000001', url, viewer: { username: viewer }, posts: url.includes('/messages') ? [structuredClone(privatePost)] : [], warnings: [], observedAt: new Date().toISOString(), text: url.includes('/messages') ? 'SYNTHETIC_PRIVATE_MESSAGE_WINDOW' : '',
        composerState: { present: false, nonempty: false, attachments: false, ambiguous: false } } as T;
      throw new Error('Unexpected browser effect in HTTP parity fixture');
    },
  };
  const service = new ThreadsService(new RemoteReadDriver(raw), new SearchIndex(dataDir), { dataDir, profileDir: dataDir, channel: 'chrome', headless: true, writesEnabled: options.writes === true, timeoutMs: 100, minActionIntervalMs: 0 });
  let http: Awaited<ReturnType<typeof startRemoteHttp>>;
  try { http = await startRemoteHttp(service, { port: 0, readToken: () => token, controlledWrites: options.writes, controlledMedia: options.media, capabilities: options.capabilities, socialDriver: raw }); }
  catch (error) { await service.close(); rmSync(dataDir, { recursive: true, force: true }); throw error; }
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const connect = async () => {
    const client = new Client({ name: 'remote-parity-fixture', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  return { service, commands, connect, viewer: (account: string) => { viewer = account; },
    rotate: () => { token = randomBytes(32).toString('base64url'); },
    health: async () => { const response = await fetch(origin + '/healthz', { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); return response.json() as Promise<any>; },
    close: async () => { for (const client of clients) await client.close(); await new Promise<void>(resolve => http.close(() => resolve())); await service.close(); assert.equal(dirname(dataDir), tmpdir()); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(response.structuredContent, 'Successful remote result must be structured');
  return response.structuredContent as any;
}
async function rejected(client: Client, name: string, args: Record<string, unknown>, code?: string) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, `${name} must reject`);
  if (code) assert.match(JSON.stringify(response), new RegExp(code));
}

test('HTTP capability opt-ins preserve 15/18/19 baselines and expose the exact full 44-tool surface', async () => {
  const cases = [
    { name: 'read-only', writes: false, count: 15 }, { name: 'controlled', writes: true, count: 18 }, { name: 'media', writes: true, media: true, count: 19 },
    ...capabilityKeys.map(key => ({ name: key, writes: !['extendedReads', 'messages'].includes(key), capabilities: { [key]: true }, count: (['extendedReads', 'messages'].includes(key) ? 15 : 18) + groups[key].length })),
    { name: 'full', writes: true, media: true, capabilities: allCapabilities, count: 44 },
  ];
  for (const options of cases) {
    const f = await fixture(options);
    try {
      const client = await f.connect(), listed = (await client.listTools()).tools;
      const names = listed.map(tool => tool.name), capabilities = Object.fromEntries(capabilityKeys.map(key => [key, (options as any).capabilities?.[key] === true]));
      const expected = [...baseTools, ...(options.writes ? socialTools : []), ...((options as any).media ? ['threads_stage_media_remote'] : []), ...capabilityKeys.flatMap(key => capabilities[key] ? groups[key] : [])];
      assert.equal(names.length, options.count, options.name); assert.deepEqual(new Set(names), new Set(expected), options.name);
      const health = await f.health(), status = await call(client, 'threads_status');
      assert.deepEqual(health.capabilities, capabilities); assert.deepEqual(status.capabilities, capabilities);
      assert.equal(health.writesEnabled, options.writes); assert.equal(health.mediaEnabled, !!(options as any).media);
      if (options.writes) {
        const schema = listed.find(tool => tool.name === 'threads_prepare_social')!.inputSchema as any;
        assert.equal(schema.properties.kind.enum.includes('delete'), capabilities.delete, options.name);
        assert.equal(status.allowedWriteKinds.includes('delete'), capabilities.delete);
      }
      assert.equal(f.commands.length, 0, 'Discovery and health must not touch browser pages');
      for (const forbidden of ['threads_read_page', 'threads_export', 'threads_stage_media', 'threads_account_insights', 'threads_evaluate', 'threads_execute_javascript']) {
        assert.ok(!names.includes(forbidden));
        if (options.name === 'full') await assert.rejects(client.callTool({ name: forbidden, arguments: {} }), /not found/);
      }
    } finally { await f.close(); }
  }
});

test('HTTP private messages cannot enter through extended feed without opt-in; authorized private reads remain unindexed', async () => {
  const f = await fixture({ capabilities: { extendedReads: true } });
  try {
    const client = await f.connect(), tools = (await client.listTools()).tools;
    assert.ok(!(tools.find(tool => tool.name === 'threads_get_feed')!.inputSchema as any).properties.kind.enum.includes('messages'));
    await rejected(client, 'threads_get_feed', { kind: 'messages', expectedAccount: 'fixture', purpose: 'Inspect fixture message list' });
    await assert.rejects(client.callTool({ name: 'threads_get_messages', arguments: { expectedAccount: 'fixture', purpose: 'Inspect fixture message list' } }), /not found/);
    assert.equal(f.commands.length, 0);
  } finally { await f.close(); }
  const enabled = await fixture({ capabilities: { messages: true } });
  try {
    const client = await enabled.connect();
    await rejected(client, 'threads_get_messages', { expectedAccount: 'another', purpose: 'Inspect fixture message list' }, 'ACCOUNT_MISMATCH');
    assert.ok(enabled.commands.every(command => command.type === 'read'), 'Account mismatch must precede navigation');
    const result = await call(client, 'threads_get_messages', { expectedAccount: 'fixture', purpose: 'Inspect fixture message list', rounds: 0 });
    assert.equal(result.visibleText, 'SYNTHETIC_PRIVATE_MESSAGE_WINDOW'); assert.equal(result.mayMarkSeen, true); assert.equal(result.privateDataPersisted, false); assert.equal(result.completeness, 'partial');
    assert.equal(result.items[0].id, privatePost.id);
    assert.equal(enabled.service.index.stats().posts, 0);
    assert.ok(enabled.commands.every(command => ['read', 'remote_view'].includes(String(command.type))));
  } finally { await enabled.close(); }
});

test('HTTP stateless clients retain account-bound draft snapshots but bearer rotation cancels authorized schedules before dispatch', async () => {
  const f = await fixture({ writes: true, capabilities: { schedule: true } });
  try {
    const first = await f.connect();
    for (const extra of [{ paths: ['C:\\private.png'] }, { media: [{ type: 'image', url: 'https://example.com/a.png' }] }, { altText: 'fixture' }])
      await rejected(first, 'threads_save_draft', { accountId: 'fixture', draft: { text: 'fixture draft', ...extra } });
    await rejected(first, 'threads_save_draft', { accountId: 'fixture', draft: { text: 'fixture draft' }, localPath: 'C:\\private.png' });
    assert.equal(f.commands.length, 0, 'Strict schema rejection happens before account reads or storage');
    const draft = await call(first, 'threads_save_draft', { accountId: 'fixture', draft: { text: 'immutable fixture text' } });
    const second = await f.connect();
    const staged = await call(second, 'threads_stage_schedule', { accountId: 'fixture', draftIds: [draft.id], at: '2020-01-01T00:00:00Z' });
    assert.equal(staged.status, 'staged');
    await call(first, 'threads_save_draft', { accountId: 'fixture', id: draft.id, draft: { text: 'edited after staging' } });
    const authorized = await call(second, 'threads_authorize_schedule', { accountId: 'fixture', id: staged.id });
    assert.equal(authorized.status, 'authorized');
    assert.match(JSON.stringify(authorized), /immutable fixture text/); assert.doesNotMatch(JSON.stringify(authorized), /edited after staging/);
    assert.ok(f.commands.every(command => command.type === 'read'), 'Save/stage/authorize never publishes or stages a browser composer');
    f.viewer('another');
    await rejected(first, 'threads_list_drafts', { accountId: 'fixture' }, 'ACCOUNT_MISMATCH');
    f.viewer('fixture'); f.rotate();
    await assert.rejects(first.callTool({ name: 'threads_list_schedules', arguments: { accountId: 'fixture' } }), /401|Unauthorized/);
    const fresh = await f.connect();
    const schedules = await call(fresh, 'threads_list_schedules', { accountId: 'fixture' });
    assert.equal(schedules.items.find((job: any) => job.id === staged.id).status, 'cancelled');
    const result = await call(fresh, 'threads_run_schedules', { accountId: 'fixture' });
    assert.equal(result.jobs.length, 0); assert.ok(f.commands.every(command => command.type === 'read'));
  } finally { await f.close(); }
});

test('HTTP official API opt-in reports missing host credentials honestly and never substitutes browser login', async () => {
  const prior = { token: process.env.THREADS_API_ACCESS_TOKEN, user: process.env.THREADS_API_USER_ID };
  delete process.env.THREADS_API_ACCESS_TOKEN; delete process.env.THREADS_API_USER_ID;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture({ writes: true, capabilities: { officialApi: true } });
    const client = await f.connect(), status = await call(client, 'threads_api_status');
    assert.equal(status.configured, false); assert.equal(status.authentication, 'not_checked'); assert.equal(status.scopes, 'not_checked');
    assert.equal(status.writeIdentityConfigured, false); assert.equal(status.liveWriteVerified, false); assert.equal(status.remoteOfficialApiEnabled, true);
    await rejected(client, 'threads_api_read', { operation: 'own_profile', input: {} }, 'API_NOT_CONFIGURED');
    assert.equal(f.commands.length, 0);
    assert.doesNotMatch(JSON.stringify(status), /accessToken|access_token/);
  } finally {
    await f?.close();
    if (prior.token === undefined) delete process.env.THREADS_API_ACCESS_TOKEN; else process.env.THREADS_API_ACCESS_TOKEN = prior.token;
    if (prior.user === undefined) delete process.env.THREADS_API_USER_ID; else process.env.THREADS_API_USER_ID = prior.user;
  }
});
