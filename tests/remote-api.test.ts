import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteOfficialApiController } from '../src/remote-api.js';
import type { OfficialAction } from '../src/official-api.js';
import type { ThreadsService } from '../src/service.js';
import { ThreadsError } from '../src/types.js';

const syntheticToken = 'remote-api-offline-fixture-token';
const identity = { id: '123', username: 'fixture' };
const action: OfficialAction = { kind: 'create_container', container: { media_type: 'TEXT', text: 'Explicit fixture caption' } };
const purpose = 'Create the specifically approved fixture container';
type Call = { url: URL; init: RequestInit };
function fixture(t: TestContext, options: { writes?: boolean; allowDelete?: boolean; configured?: boolean; userId?: string } = {}) {
  const env = ['THREADS_API_ACCESS_TOKEN', 'THREADS_API_USER_ID', 'THREADS_ALLOW_WRITES'] as const;
  const saved = env.map(key => process.env[key]);
  process.env.THREADS_API_ACCESS_TOKEN = options.configured === false ? '' : syntheticToken;
  process.env.THREADS_API_USER_ID = options.userId ?? '123';
  // An inherited general write flag must not elevate the remote controller.
  process.env.THREADS_ALLOW_WRITES = 'true';
  t.after(() => env.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  const calls: Call[] = [];
  let denied = false;
  let reply: (call: Call) => Promise<Response> = async call => new Response(JSON.stringify(call.url.pathname.endsWith('/me') ? identity : { id: '456' }));
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(url)), init: init ?? {} }; calls.push(call); return reply(call);
  });
  const service = { config: { writesEnabled: options.writes ?? true } } as ThreadsService;
  const gates = { allowDelete: options.allowDelete ?? false };
  const access = () => { if (denied) throw new ThreadsError('ACCESS_CHANGED', 'secret callback diagnostic'); };
  const controller = new RemoteOfficialApiController(service, access, gates);
  return { controller, calls, service, gates, deny: () => { denied = true; }, invalidate: () => controller.invalidate(),
    respond: (handler: typeof reply) => { reply = handler; },
    restart: () => new RemoteOfficialApiController(service, access, gates) };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const expectCode = (operation: Promise<unknown>, code: string) => assert.rejects(operation, (error: any) => error.code === code);

test('remote API unconfigured status is honest and reads cannot manufacture successful data', async t => {
  const f = fixture(t, { configured: false, writes: false });
  assert.deepEqual({ configured: f.controller.status().configured, authentication: f.controller.status().authentication,
    writes: f.controller.status().writesEnabled, deletion: f.controller.status().deleteEnabled },
  { configured: false, authentication: 'not_checked', writes: false, deletion: false });
  await expectCode(f.controller.read('own_profile'), 'API_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.controller.status()), /offline-fixture-token|access_token|secret callback/);
});

test('read-only official access uses fixed API paths and strips credentials and paging URLs', async t => {
  const f = fixture(t, { writes: false });
  f.respond(async () => json({ data: [{ id: '7', likes: null }], access_token: syntheticToken,
    echo: syntheticToken, paging: { next: `https://example.com/?access_token=${syntheticToken}`, cursors: { after: 'next-page' } } }));
  const result = await f.controller.read('search', { q: 'fixture', limit: 3 });
  assert.equal(result.completeness, 'api_page');
  assert.equal(JSON.stringify(f.controller).includes(syntheticToken), false);
  assert.equal(f.calls[0].url.origin, 'https://graph.threads.com');
  assert.equal(f.calls[0].url.pathname, '/v1.0/keyword_search');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), `Bearer ${syntheticToken}`);
  assert.deepEqual(result.data.paging, { cursors: { after: 'next-page' } });
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  await expectCode(f.controller.prepare(action, '123', purpose), 'WRITES_DISABLED');
  assert.equal(f.calls.length, 1);
});

test('prepare rejects credentials, paths, missing purpose and account mismatch before dispatch', async t => {
  const f = fixture(t);
  for (const invalid of ['', ' ', syntheticToken, 'a'.repeat(501)])
    await expectCode(f.controller.prepare(action, '123', invalid), 'INVALID_INPUT');
  await expectCode(f.controller.prepare(action, 'fixture', purpose), 'INVALID_INPUT');
  await expectCode(f.controller.prepare(action, '999', purpose), 'API_IDENTITY_MISMATCH');
  await expectCode(f.controller.prepare({ ...action, accessToken: 'injected' } as OfficialAction, '123', purpose), 'INVALID_INPUT');
  await expectCode(f.controller.prepare({ kind: 'create_container', container: { media_type: 'IMAGE', image_url: 'file:///C:/private.png' } }, '123', purpose), 'INVALID_INPUT');
  await expectCode(f.controller.read('post', { id: '../private' }), 'INVALID_INPUT');
  await expectCode(f.controller.read('post', { id: '1', accessToken: 'injected' } as any), 'INVALID_INPUT');
  assert.equal(f.calls.length, 0);
  f.respond(async () => json({ id: '999', username: 'other' }));
  await expectCode(f.controller.prepare(action, '123', purpose), 'API_IDENTITY_MISMATCH');
  assert.equal(f.calls.length, 1);
});

test('explicit numeric configured identity is required even if the token has an identity', async t => {
  const f = fixture(t, { userId: 'me' });
  await expectCode(f.controller.prepare(action, '123', purpose), 'API_IDENTITY_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('preparation is immutable, host-bound and execute consumes once before concurrent awaits', async t => {
  const f = fixture(t);
  const prepared = await f.controller.prepare(action, '123', purpose);
  assert.equal(prepared.executed, false); assert.equal(prepared.account.id, '123'); assert.equal(prepared.purpose, purpose);
  assert.equal('preparedId' in prepared, false);
  if (prepared.action.kind === 'create_container') prepared.action.container.text = 'tampered';
  const results = await Promise.allSettled([f.controller.execute(prepared.id, '123'), f.controller.execute(prepared.id, '123')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const success = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  assert.equal(success.preparedId, prepared.id); assert.equal(success.outcome, 'api_confirmed');
  const mutations = f.calls.filter(call => call.init.method === 'POST');
  assert.equal(mutations.length, 1);
  assert.equal(new URLSearchParams(String(mutations[0].init.body)).get('text'), 'Explicit fixture caption');
  await expectCode(f.controller.execute(prepared.id, '123'), 'API_PREPARED_NOT_FOUND');
  const next = await f.controller.prepare(action, '123', purpose);
  await expectCode(f.controller.execute(next.id, '999'), 'API_IDENTITY_MISMATCH');
  await expectCode(f.controller.execute(next.id, '123'), 'API_PREPARED_NOT_FOUND');
});

test('delete has its own gate at preparation and execution', async t => {
  const f = fixture(t);
  const deletion: OfficialAction = { kind: 'delete_post', post_id: '777' };
  await expectCode(f.controller.prepare(deletion, '123', 'Delete approved fixture post'), 'REMOTE_DELETE_DISABLED');
  assert.equal(f.calls.length, 0);
  f.gates.allowDelete = true;
  const blocked = await f.controller.prepare(deletion, '123', 'Delete approved fixture post');
  f.gates.allowDelete = false;
  await expectCode(f.controller.execute(blocked.id, '123'), 'REMOTE_DELETE_DISABLED');
  f.gates.allowDelete = true;
  await expectCode(f.controller.execute(blocked.id, '123'), 'API_PREPARED_NOT_FOUND');
  const allowed = await f.controller.prepare(deletion, '123', 'Delete approved fixture post');
  f.respond(async call => json(call.init.method === 'DELETE' ? { success: true } : identity));
  assert.equal((await f.controller.execute(allowed.id, '123')).outcome, 'api_confirmed');
  assert.equal(f.calls.filter(call => call.init.method === 'DELETE').length, 1);
});

test('revocation during prepare prevents retaining a usable host preparation', async t => {
  const f = fixture(t);
  f.respond(async () => { f.invalidate(); return json(identity); });
  await expectCode(f.controller.prepare(action, '123', purpose), 'API_PREPARATION_REVOKED');
  assert.equal(f.calls.length, 1);
  f.respond(async () => json(identity));
  const prepared = await f.controller.prepare(action, '123', purpose);
  f.invalidate();
  await expectCode(f.controller.execute(prepared.id, '123'), 'API_PREPARED_NOT_FOUND');
  const next = await f.controller.prepare(action, '123', purpose);
  await expectCode(f.restart().execute(next.id, '123'), 'API_PREPARED_NOT_FOUND');
});

test('access checked before each async identity/status/mutation dispatch; no later request after revocation', async t => {
  const f = fixture(t);
  const publish: OfficialAction = { kind: 'publish_container', creation_id: '456' };
  const prepared = await f.controller.prepare(publish, '123', 'Publish the approved fixture container');
  f.respond(async call => {
    if (call.url.pathname.endsWith('/me')) return json(identity);
    f.deny(); return json({ id: '456', status: 'FINISHED' });
  });
  await assert.rejects(f.controller.execute(prepared.id, '123'), (error: any) => {
    assert.equal(error.code, 'API_ACCESS_CHANGED'); assert.equal(error.outcome, 'not_sent');
    assert.doesNotMatch(error.message, /secret callback/); return true;
  });
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => call.init.method === 'GET'));
});

test('old API instance cannot continue its identity request after invalidate, even when new access is valid', async t => {
  const f = fixture(t);
  const p = await f.controller.prepare({ kind: 'publish_container', creation_id: '456' }, '123', 'Publish approved fixture');
  f.respond(async () => { f.invalidate(); return json(identity); });
  await expectCode(f.controller.execute(p.id, '123'), 'API_ACCESS_CHANGED');
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.init.method === 'GET'));
});

test('uncertain mutations are never replayed and transport diagnostics are not exposed', async t => {
  const f = fixture(t);
  const p = await f.controller.prepare(action, '123', purpose);
  f.respond(async call => { if (call.init.method === 'POST') throw new Error(`private ${syntheticToken}`); return json(identity); });
  await assert.rejects(f.controller.execute(p.id, '123'), (error: any) => {
    assert.equal(error.outcome, 'unknown'); assert.equal(error.code, 'API_TRANSPORT_FAILED');
    assert.equal(error.message.includes(syntheticToken), false); return true;
  });
  await expectCode(f.controller.execute(p.id, '123'), 'API_PREPARED_NOT_FOUND');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('public API media URL stays separate from browser byte uploads', async t => {
  const f = fixture(t);
  const p = await f.controller.prepare({ kind: 'create_container', container: {
    media_type: 'IMAGE', image_url: 'https://example.com/approved.jpg', alt_text: 'Approved fixture image' } }, '123', purpose);
  await f.controller.execute(p.id, '123');
  const body = new URLSearchParams(String(f.calls.at(-1)?.init.body));
  assert.equal(body.get('image_url'), 'https://example.com/approved.jpg');
  assert.equal(body.get('alt_text'), 'Approved fixture image');
  assert.ok(f.calls.every(call => call.url.origin === 'https://graph.threads.com'));
});

test('expired preparation cannot dispatch, and revocation after dispatch reports uncertain', async t => {
  const f = fixture(t);
  const p = await f.controller.prepare(action, '123', purpose);
  const now = t.mock.method(Date, 'now', () => Date.parse(p.expiresAt));
  await expectCode(f.controller.execute(p.id, '123'), 'API_PREPARED_EXPIRED');
  assert.equal(f.calls.length, 1); now.mock.restore();
  const q = await f.controller.prepare(action, '123', purpose);
  f.respond(async call => { if (call.init.method === 'POST') { f.invalidate(); return json({ id: '456' }); } return json(identity); });
  await assert.rejects(f.controller.execute(q.id, '123'), (error: any) => error.code === 'API_ACCESS_CHANGED' && error.outcome === 'unknown');
  await expectCode(f.controller.execute(q.id, '123'), 'API_PREPARED_NOT_FOUND');
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});
