import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelDirectProfiles, directProfile } from '../src/direct-profile-runtime.js';

const username = 'fixture';
const queryUrl = 'https://www.threads.com/graphql/query';
const operation = '__d("BarcelonaProfileThreadsTabRefetchableDirectQuery_threadsRelayOperation",[],function(){module.exports="12345678901234"});' +
  '__d("BarcelonaProfileThreadsTabRefetchableDirectQuery.threads.graphql",[],function(){return {operationKind:"query",name:"BarcelonaProfileThreadsTabRefetchableDirectQuery",flag:"__relay_internal__pv__Fixture"}});';
const post = (id: number, author = username) => ({ pk: String(id), code: `Code${id}`, user: { pk: author === username ? '42' : '43', username: author }, caption: { text: `Post ${id}` } });
const connection = (ids: number[], cursor: string | null, hasNext = true) => ({ edges: ids.map(id => ({ node: { thread_items: [{ post: post(id) }] } })), page_info: { end_cursor: cursor, has_next_page: hasNext } });
function bootstrap() {
  return {
    profile: { pk: '42', username, text_post_app_is_private: false, full_name: 'Fixture' },
    query: { variables: { userID: '42', first: 2, __relay_internal__pv__Fixture: true, allow_page_info_for_lox_user: true } },
    data: { mediaData: connection([1, 2], 'cursor-a') },
    config: [['LSD', [], { token: 'fixture-lsd' }], ['DTSGInitialData', [], { token: 'fixture-dtsg' }],
      ['InstagramSecurityConfig', [], { csrf_token: 'fixture-csrf' }]],
  };
}
type FixtureOptions = {
  initial?: any; responses?: any[]; staticText?: string;
  onFetch?: (url: string, options: RequestInit, request: number) => Promise<Response> | Response | undefined;
};
async function fixture(run: (fixture: { calls: Array<{ url: string; options: RequestInit }>; context: { viewer: () => string; guard: () => void }; navigation: { href: string } }) => Promise<void>, options: FixtureOptions = {}) {
  const documentEvents = new EventTarget(), windowEvents = new EventTarget();
  const navigation = { href: `https://www.threads.com/@${username}` };
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const initial = options.initial ?? bootstrap();
  let request = 0;
  const mocks: Record<string, unknown> = {
    location: navigation,
    document: {
      baseURI: 'https://foreign.invalid/hostile-base/',
      addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      querySelectorAll: (selector: string) => selector.includes('application/json') ? [{ textContent: JSON.stringify(initial) }] : [{ src: 'https://static.cdninstagram.com/query.js' }],
    },
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, options: init });
      if (url !== queryUrl) return new Response(options.staticText ?? operation);
      request++;
      const intercepted = await options.onFetch?.(url, init, request);
      if (intercepted) return intercepted;
      return new Response(JSON.stringify(options.responses?.[request - 1] ?? { data: { mediaData: connection([request + 2], `cursor-${request}`) } }));
    },
  };
  const original = new Map(Object.keys(mocks).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(mocks)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  try { await run({ calls, context: { viewer: () => 'viewer', guard: () => {} }, navigation }); }
  finally {
    cancelDirectProfiles();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
  }
}
const args = { username, maxPages: 3, pageSize: 3 };

test('direct profile collects successive pages, deduplicates IDs, and keeps session fields internal', async () => {
  await fixture(async ({ context, calls }) => {
    const result = await directProfile(args, context);
    assert.deepEqual(result.items.map(item => item.id), ['1', '2', '3', '4', '5']);
    assert.deepEqual(result.pagination.pages.map(page => page.added), [2, 1, 2]);
    assert.equal(result.pagination.requests, 2);
    assert.equal(result.pagination.pagesFetched, 3);
    assert.equal(result.pagination.stopReason, 'end_of_connection');
    assert.equal(result.completeness, 'partial');
    assert.equal(result.profile?.private, false);
    assert.ok(result.items.every(item => item.source === 'profile-direct' && item.likes === null));
    assert.deepEqual(result.contextualPosts, []);
    assert.doesNotMatch(JSON.stringify(result), /cursor-a|cursor-b|fixture-lsd|fixture-csrf|fixture-dtsg|doc_id/);
    assert.equal(calls[0]!.options.credentials, 'omit');
    assert.ok(calls.every(call => call.options.redirect === 'error'));
    const queries = calls.filter(call => call.url === queryUrl);
    assert.equal(queries.length, 2, 'absolute query URL must ignore external document.baseURI');
    assert.ok(calls.every(call => !call.url.includes('foreign.invalid')));
    assert.ok(queries.every(call => call.options.credentials === 'same-origin'));
    assert.equal(JSON.parse((queries[1]!.options.body as URLSearchParams).get('variables')!).after, 'cursor-b');
  }, { responses: [
    { data: { mediaData: connection([2, 3, 3], 'cursor-b') } },
    { data: { mediaData: connection([4, 5], null, false) } },
  ] });
});

test('direct profile enforces total page budget, with no fetch for initial-page-only read', async () => {
  await fixture(async ({ context, calls }) => {
    const result = await directProfile({ ...args, maxPages: 1 }, context);
    assert.equal(result.pagination.pagesFetched, 1);
    assert.equal(result.pagination.stopReason, 'page_limit');
    assert.equal(calls.length, 0);
    await assert.rejects(directProfile({ ...args, maxPages: 6 }, context), /INVALID_INPUT/);
    await assert.rejects(directProfile({ ...args, pageSize: 21 }, context), /INVALID_INPUT/);
  });
});

test('direct profile stops cursor loops and repeated pages without replay', async () => {
  for (const [page, reason] of [[connection([3], 'cursor-a'), 'cursor_loop'], [connection([1, 2], 'cursor-b'), 'no_progress']] as const) {
    await fixture(async ({ context }) => {
      const result = await directProfile({ ...args, maxPages: 5 }, context);
      assert.equal(result.pagination.stopReason, reason);
      assert.equal(result.pagination.requests, 1);
    }, { responses: [{ data: { mediaData: page } }] });
  }
});

test('direct profile fails closed before accepting private or ambiguous bootstrap', async () => {
  const privateData = bootstrap(); privateData.profile.text_post_app_is_private = true;
  const ambiguous = { ...bootstrap(), other: { username, pk: '99' } };
  for (const initial of [privateData, ambiguous]) await fixture(async ({ context, calls }) => {
    await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_BINDING_UNAVAILABLE/);
    assert.equal(calls.length, 0);
  }, { initial });
});

test('direct profile rejects a mismatched author or invalid ID without accepting that page', async () => {
  for (const invalid of [post(3, 'foreign'), { ...post(3), pk: 'not-numeric' }, { ...post(3), code: undefined }]) {
    const bad = connection([3], 'cursor-b'); bad.edges[0]!.node.thread_items[0]!.post = invalid as any;
    await fixture(async ({ context }) => {
      const result = await directProfile(args, context);
      assert.equal(result.pagination.stopReason, 'binding_unavailable');
      assert.equal(result.pagination.pagesFetched, 1);
      assert.deepEqual(result.items.map(item => item.id), ['1', '2']);
    }, { responses: [{ data: { mediaData: bad } }] });
  }
});

test('direct profile rejects GraphQL partial errors and limits without exposing raw errors', async () => {
  for (const [response, reason] of [
    [{ errors: [{ message: 'private-error-do-not-return' }], data: { mediaData: connection([3], 'cursor-b') } }, 'graphql_error'],
    [{ data: { mediaData: connection([3, 4, 5, 6], 'cursor-b') } }, 'schema_unavailable'],
    [{ data: {} }, 'schema_unavailable'],
  ] as const) await fixture(async ({ context }) => {
    const result = await directProfile(args, context);
    assert.equal(result.pagination.stopReason, reason);
    assert.equal(result.pagination.pagesFetched, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-error/);
  }, { responses: [response] });
});

test('direct profile preserves accepted pages on HTTP failure and never retries a query', async () => {
  await fixture(async ({ context }) => {
    const result = await directProfile(args, context);
    assert.equal(result.pagination.stopReason, 'http_rejected');
    assert.equal(result.pagination.requests, 1);
    assert.equal(result.items.length, 2);
  }, { onFetch: () => new Response('private server error', { status: 403 }) });
});

test('direct profile requires current verified read artifact before querying', async () => {
  await fixture(async ({ context, calls }) => {
    const result = await directProfile(args, context);
    assert.equal(result.pagination.stopReason, 'query_unavailable');
    assert.equal(calls.filter(call => call.url === queryUrl).length, 0);
  }, { staticText: operation.replace('operationKind:"query"', 'operationKind:"mutation"') });
});

test('direct profile rejects credential-bearing and nondefault-port origins', async () => {
  for (const route of ['https://www.threads.com:8443/@fixture', 'https://user:pass@www.threads.com/@fixture']) {
    await fixture(async ({ context, navigation, calls }) => {
      navigation.href = route;
      await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_BINDING_UNAVAILABLE/);
      assert.equal(calls.length, 0);
    });
  }
});

test('direct profile stops missing cursors and oversized response bodies', async () => {
  await fixture(async ({ context }) => {
    const result = await directProfile(args, context);
    assert.equal(result.pagination.stopReason, 'cursor_missing');
    assert.equal(result.pagination.requests, 1);
    assert.equal(result.pagination.pagesFetched, 2);
  }, { responses: [{ data: { mediaData: connection([3], null) } }] });
  await fixture(async ({ context }) => {
    const result = await directProfile(args, context);
    assert.equal(result.pagination.stopReason, 'response_limit');
    assert.equal(result.pagination.pagesFetched, 1);
    assert.equal(result.pagination.requests, 1);
  }, { onFetch: () => new Response('x'.repeat(3_000_001)) });
});

test('direct profile discards accumulated pages when route or viewer changes', async () => {
  let mutate: () => void;
  await fixture(async ({ context, navigation }) => {
    mutate = () => { navigation.href = 'https://www.threads.com/@different'; };
    await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_CONTEXT_CHANGED/);
  }, { onFetch: () => { mutate(); return new Response(JSON.stringify({ data: { mediaData: connection([3], 'cursor-b') } })); } });
  await fixture(async ({ context }) => {
    mutate = () => { context.viewer = () => 'another-viewer'; };
    await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_CONTEXT_CHANGED/);
  }, { onFetch: () => { mutate(); return new Response(JSON.stringify({ data: { mediaData: connection([3], 'cursor-b') } })); } });
});

test('direct profile disconnect cancellation aborts pending request and returns no stale partial', async () => {
  await fixture(async ({ context }) => {
    await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_CANCELLED/);
  }, { onFetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('private abort message')), { once: true });
    cancelDirectProfiles();
  }) });
});

test('direct profile checks takeover guard while a request is pending', async () => {
  let takeover = false;
  await fixture(async ({ context }) => {
    context.guard = () => { if (takeover) throw new Error('takeover'); };
    await assert.rejects(directProfile(args, context), /DIRECT_PROFILE_CONTEXT_CHANGED/);
  }, { onFetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    takeover = true;
  }) });
});
