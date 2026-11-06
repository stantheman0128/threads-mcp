import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialThreadsApi, OfficialApiError, officialApiOptionsFromEnv, type OfficialAction } from '../src/official-api.js';

// Synthetic credential, never a live token. No test uses a network transport.
const syntheticCredential = 'offline-fixture-credential';
type Call = { url: URL; init: RequestInit };
function fixture(replies: Array<unknown | Error | { httpStatus: number; payload: unknown }>, options = {}) {
  const calls: Call[] = [];
  const api = new OfficialThreadsApi({ accessToken: syntheticCredential, userId: '123', writesEnabled: true,
    fetch: async (url, init) => {
      calls.push({ url: new URL(String(url)), init: init ?? {} });
      assert.ok(replies.length, 'Unexpected request');
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (next && typeof next === 'object' && 'httpStatus' in next) {
        const result = next as { httpStatus: number; payload: unknown };
        return new Response(JSON.stringify(result.payload), { status: result.httpStatus });
      }
      return new Response(JSON.stringify(next));
    }, ...options });
  return { api, calls };
}
const account = () => ({ id: '123', username: 'fixture_user' });
const textAction: OfficialAction = { kind: 'create_container', container: { media_type: 'TEXT', text: 'Offline fixture' } };

test('unconfigured status is local and does not expose credentials', async () => {
  const api = new OfficialThreadsApi({ writesEnabled: false });
  assert.equal(api.status().configured, false);
  await assert.rejects(api.read('own_profile'), { code: 'API_NOT_CONFIGURED' });
  const configured = fixture([]).api;
  assert.equal(JSON.stringify(configured).includes(syntheticCredential), false);
  assert.equal(JSON.stringify(configured.status()).includes(syntheticCredential), false);
  assert.equal(new OfficialThreadsApi(officialApiOptionsFromEnv({ THREADS_API_ACCESS_TOKEN: '', THREADS_API_USER_ID: '' })).status().userId, 'me');
  assert.equal(new OfficialThreadsApi({ userId: '  ' }).status().userId, 'me');
  assert.deepEqual(officialApiOptionsFromEnv({ THREADS_API_USER_ID: '123', THREADS_ALLOW_WRITES: 'TRUE' }).writesEnabled, false);
});

test('read uses fixed official host, bearer header and bounded cursor without exposing paging tokens', async () => {
  const { api, calls } = fixture([{ data: [{ id: '1', text: 'hello', likes: null }],
    access_token: syntheticCredential,
    paging: { next: `https://graph.threads.com/next?access_token=${syntheticCredential}`, cursors: { after: 'cursor-2' } },
    detail: `echo ${syntheticCredential}` }]);
  const result = await api.read('search', { q: '中文', limit: 20, after: 'cursor-1', search_type: 'RECENT' });
  assert.equal(calls[0].url.origin, 'https://graph.threads.com');
  assert.equal(calls[0].url.pathname, '/v1.0/keyword_search');
  assert.equal(calls[0].url.searchParams.get('q'), '中文');
  assert.equal(calls[0].url.searchParams.get('after'), 'cursor-1');
  assert.equal(calls[0].url.searchParams.has('access_token'), false);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${syntheticCredential}`);
  assert.equal(JSON.stringify(result).includes(syntheticCredential), false);
  assert.deepEqual(result.data.paging, { cursors: { after: 'cursor-2' } });
  assert.equal(result.completeness, 'api_page');
});

test('read operation paths preserve public discovery, account insight and reply scope', async () => {
  const { api, calls } = fixture(Array.from({ length: 7 }, () => ({ data: [] })));
  await api.read('profile_lookup', { username: 'meta' });
  await api.read('profile_posts', { username: 'meta' });
  await api.read('mentions');
  await api.read('conversation', { id: '456', reverse: false });
  await api.read('pending_replies', { id: '456', approval_status: 'ignored' });
  await api.read('user_insights', { metric: 'follower_demographics', breakdown: 'country' });
  await api.read('post_insights', { id: '456' });
  assert.deepEqual(calls.map(c => c.url.pathname), ['/v1.0/profile_lookup', '/v1.0/profile_posts', '/v1.0/123/mentions', '/v1.0/456/conversation', '/v1.0/456/pending_replies', '/v1.0/123/threads_insights', '/v1.0/456/insights']);
  assert.equal(calls[3].url.searchParams.get('reverse'), 'false');
  assert.equal(calls[4].url.searchParams.get('approval_status'), 'ignored');
  assert.equal(calls[5].url.searchParams.get('breakdown'), 'country');
  await assert.rejects(api.read('post', {}), { code: 'INVALID_INPUT' });
  await assert.rejects(api.read('user_insights', { metric: 'follower_demographics' }), { code: 'INVALID_INPUT' });
});

test('write gate and exact account configuration apply before any request', async () => {
  for (const [options, code] of [[{ writesEnabled: false }, 'WRITES_DISABLED'], [{ userId: undefined }, 'API_IDENTITY_REQUIRED']] as const) {
    const { api, calls } = fixture([], options);
    await assert.rejects(api.prepare(textAction), { code });
    assert.equal(calls.length, 0);
  }
  const mismatch = fixture([{ id: '999', username: 'other_account' }]);
  await assert.rejects(mismatch.api.prepare(textAction), { code: 'API_IDENTITY_MISMATCH' });
});

test('prepared content is immutable, account-bound and one-shot under concurrent execute', async () => {
  const { api, calls } = fixture([account(), account(), { id: '456' }]);
  const prepared = await api.prepare(textAction);
  if (prepared.action.kind === 'create_container') prepared.action.container.text = 'changed after review';
  const results = await Promise.allSettled([api.execute(prepared.preparedId), api.execute(prepared.preparedId)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const sent = calls.filter(c => c.init.method === 'POST');
  assert.equal(sent.length, 1);
  assert.equal(new URLSearchParams(String(sent[0].init.body)).get('text'), 'Offline fixture');
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'API_PREPARED_NOT_FOUND');
});

test('identity switch after preparation prevents sending and consumes action', async () => {
  const { api, calls } = fixture([account(), { id: '999', username: 'other' }]);
  const prepared = await api.prepare(textAction);
  await assert.rejects(api.execute(prepared.preparedId), { code: 'API_IDENTITY_MISMATCH' });
  assert.ok(calls.every(c => c.init.method === 'GET'));
  await assert.rejects(api.execute(prepared.preparedId), { code: 'API_PREPARED_NOT_FOUND' });
});

test('expired preparation never sends a mutation', async () => {
  let now = 0;
  const { api, calls } = fixture([account()], { now: () => now, preparedTtlMs: 1000 });
  const prepared = await api.prepare(textAction);
  now = 1000;
  await assert.rejects(api.execute(prepared.preparedId), { code: 'API_PREPARED_EXPIRED' });
  assert.equal(calls.length, 1);
});

test('network uncertainty and HTTP 5xx never replay and never echo transport/server secrets', async () => {
  for (const failure of [new Error(`socket ${syntheticCredential}`), { httpStatus: 503, payload: { error: { message: syntheticCredential } } }]) {
    const { api, calls } = fixture([account(), account(), failure]);
    const prepared = await api.prepare(textAction);
    await assert.rejects(api.execute(prepared.preparedId), error => {
      assert.ok(error instanceof OfficialApiError);
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.retryable, false);
      assert.equal(JSON.stringify(error).includes(syntheticCredential), false);
      return true;
    });
    await assert.rejects(api.execute(prepared.preparedId), { code: 'API_PREPARED_NOT_FOUND' });
    assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  }
});

test('publish requires FINISHED and confirms returned published media ID', async () => {
  const { api, calls } = fixture([account(), account(), { id: '456', status: 'IN_PROGRESS' }]);
  const p = await api.prepare({ kind: 'publish_container', creation_id: '456' });
  await assert.rejects(api.execute(p.preparedId), { code: 'API_CONTAINER_NOT_READY', outcome: 'not_sent' });
  assert.ok(calls.every(c => c.init.method === 'GET'));
  const ready = fixture([account(), account(), { id: '456', status: 'FINISHED' }, { id: '789' }]);
  const q = await ready.api.prepare({ kind: 'publish_container', creation_id: '456' });
  const result = await ready.api.execute(q.preparedId);
  assert.equal(result.data.id, '789');
  assert.equal(result.outcome, 'api_confirmed');
  assert.equal(ready.calls.at(-1)?.url.pathname, '/v1.0/123/threads_publish');
});

test('carousel, image/video replies and quote container parameters use official endpoints', async () => {
  const actions: OfficialAction[] = [
    { kind: 'create_container', container: { media_type: 'IMAGE', image_url: 'https://example.com/image.jpg', is_carousel_item: true } },
    { kind: 'create_container', container: { media_type: 'VIDEO', video_url: 'https://example.com/video.mp4', reply_to_id: '456', text: 'reply' } },
    { kind: 'create_container', container: { media_type: 'CAROUSEL', children: ['100', '101'], quote_post_id: '456', reply_control: 'followers_only', enable_reply_approvals: true } },
  ];
  for (const action of actions) {
    const { api, calls } = fixture([account(), account(), { id: '789' }]);
    const p = await api.prepare(action); await api.execute(p.preparedId);
    assert.equal(calls.at(-1)?.url.pathname, '/v1.0/123/threads');
    const body = new URLSearchParams(String(calls.at(-1)?.init.body));
    if (action.kind === 'create_container' && action.container.children) assert.equal(body.get('children'), '100,101');
    assert.equal(body.has('access_token'), false);
  }
});

test('hide/unhide, approve/ignore and deletion honor booleans and actual API success', async () => {
  for (const action of [
    { kind: 'hide_reply', reply_id: '456', hide: false },
    { kind: 'manage_pending_reply', reply_id: '456', approve: false },
    { kind: 'delete_post', post_id: '456' },
  ] as OfficialAction[]) {
    const { api, calls } = fixture([account(), account(), { success: true }]);
    const p = await api.prepare(action); await api.execute(p.preparedId);
    const last = calls.at(-1)!;
    if (action.kind === 'delete_post') assert.equal(last.init.method, 'DELETE');
    else assert.equal(new URLSearchParams(String(last.init.body)).get(action.kind === 'hide_reply' ? 'hide' : 'approve'), 'false');
  }
  const failed = fixture([account(), account(), { success: false }]);
  const p = await failed.api.prepare({ kind: 'delete_post', post_id: '456' });
  await assert.rejects(failed.api.execute(p.preparedId), { code: 'API_MUTATION_UNCONFIRMED', outcome: 'unknown' });
});

test('input validation rejects path injection, conflicting media and hidden unsupported fields without requests', async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(api.read('post', { id: '../me' }), { code: 'INVALID_INPUT' });
  await assert.rejects(api.prepare({ kind: 'create_container', container: { media_type: 'TEXT', text: 'x', image_url: 'https://example.com/a.jpg' } }), { code: 'INVALID_INPUT' });
  await assert.rejects(api.prepare({ kind: 'create_container', container: { media_type: 'IMAGE', image_url: 'https://user:password@example.com/a.jpg' } }), { code: 'INVALID_INPUT' });
  await assert.rejects(api.prepare({ kind: 'create_container', container: { media_type: 'TEXT', text: syntheticCredential } }), { code: 'INVALID_INPUT' });
  await assert.rejects(api.prepare({ ...textAction, access_token: 'injected' } as OfficialAction), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
});

test('post read requests official media and relationship fields for publication verification', async () => {
  const { api, calls } = fixture([{ id: '456', media_type: 'CAROUSEL_ALBUM', children: { data: [{ id: '10' }, { id: '11' }] }, replied_to: { id: '123' } }]);
  const result = await api.read('post', { id: '456' });
  const fields = calls[0].url.searchParams.get('fields')!.split(',');
  for (const field of ['owner', 'children', 'media_type', 'media_url', 'root_post', 'replied_to', 'quoted_post']) assert.ok(fields.includes(field));
  assert.deepEqual(result.data.replied_to, { id: '123' });
});

test('permission and rate-limit responses remain errors and never fabricate empty successful data', async () => {
  for (const [httpStatus, apiCode, code] of [[401, 190, 'API_AUTH_REQUIRED'], [403, 10, 'API_PERMISSION_REQUIRED'], [429, 4, 'API_RATE_LIMITED']] as const) {
    const { api, calls } = fixture([{ httpStatus, payload: { error: { code: apiCode, message: syntheticCredential } } }]);
    await assert.rejects(api.read('mentions'), error => {
      assert.ok(error instanceof OfficialApiError);
      assert.equal(error.code, code);
      assert.equal(error.outcome, 'rejected');
      assert.equal(error.message.includes(syntheticCredential), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('timeout aborts the request and invalid JSON after mutation remains uncertain', async () => {
  let aborted = false;
  const api = new OfficialThreadsApi({ accessToken: syntheticCredential, timeoutMs: 100,
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
  await assert.rejects(api.read('own_profile'), { code: 'API_TRANSPORT_FAILED' });
  assert.equal(aborted, true);
  let request = 0;
  const mutation = new OfficialThreadsApi({ accessToken: syntheticCredential, userId: '123', writesEnabled: true,
    fetch: async () => ++request <= 2 ? new Response(JSON.stringify(account())) : new Response('not-json') });
  const prepared = await mutation.prepare(textAction);
  await assert.rejects(mutation.execute(prepared.preparedId), { code: 'API_INVALID_RESPONSE', outcome: 'unknown' });
  assert.equal(request, 3);
});
