import test from 'node:test';
import assert from 'node:assert/strict';
import { publishApiDraft } from '../src/publishing.js';
import { OfficialApiError, type OfficialThreadsApi, type OfficialAction } from '../src/official-api.js';
import type { Draft, PublishContext } from '../src/workflows.js';

const baseDraft: Draft = { id: 'draft-fixture', accountId: '123', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', text: 'Authorized fixture text' };
const context: PublishContext = { accountId: '123', jobId: 'job-fixture', partIndex: 0, idempotencyKey: 'unused-local-key' };
test('API publisher rejects browser reply URLs before any API call',async()=>{
  let calls=0;const api={read:async()=>{calls++;throw new Error('Unexpected read');}} as unknown as OfficialThreadsApi;
  const result=await publishApiDraft(api,{...baseDraft,replyUrl:'https://www.threads.com/@fixture/post/ROOT'},context);
  assert.equal(result.status,'failed');assert.equal(calls,0);
});
function fixture(options: { profile?: Record<string, unknown>; post?: Record<string, unknown>; publishError?: Error; readbackError?: Error } = {}) {
  const actions: OfficialAction[] = [];
  const prepared = new Map<string, OfficialAction>();
  const profile = options.profile ?? { id: '123', username: 'fixture_user' };
  let sequence = 0;
  const api = {
    read: async (operation: string) => { if(operation === 'post' && options.readbackError) throw options.readbackError; return { data: operation === 'own_profile' ? profile : operation === 'container_status' ? { status: 'FINISHED' } : {
      id: '900', owner: { id: '123' }, username: 'fixture_user', text: baseDraft.text, media_type: 'TEXT_POST', is_reply: false, is_quote_post: false, ...options.post,
    } }; },
    prepare: async (action: OfficialAction) => { const preparedId = String(++sequence); prepared.set(preparedId, action); return { preparedId }; },
    execute: async (preparedId: string) => {
      const action = prepared.get(preparedId)!; prepared.delete(preparedId);
      actions.push(action);
      if (action.kind === 'publish_container' && options.publishError) throw options.publishError;
      return { data: { id: action.kind === 'publish_container' ? '900' : String(100 + sequence) } };
    },
  } as unknown as OfficialThreadsApi;
  return { api, actions };
}

test('publisher confirms only a matching text post from the exact account', async () => {
  const { api, actions } = fixture();
  const result = await publishApiDraft(api, baseDraft, context);
  assert.equal(result.status, 'confirmed');
  assert.equal(actions.filter(a => a.kind === 'publish_container').length, 1);
});

test('numeric account ID cannot match a different account with a numeric username', async () => {
  const { api, actions } = fixture({ profile: { id: '999', username: '123' }, post: { username: '123' } });
  const result = await publishApiDraft(api, baseDraft, context);
  assert.equal(result.status, 'failed');
  assert.equal(actions.length, 0, 'Account mismatch must stop before creating a container');
});

test('image publication is not confirmed when readback is text-only', async () => {
  const { api } = fixture();
  const result = await publishApiDraft(api, { ...baseDraft, media: [{ type: 'image', url: 'https://example.com/photo.jpg' }] }, context);
  assert.equal(result.status, 'uncertain');
});

test('reply confirmation requires the exact replied-to ID', async () => {
  for (const post of [{ is_reply: false }, { is_reply: true, replied_to: { id: '777' } }]) {
    const { api } = fixture({ post });
    const result = await publishApiDraft(api, { ...baseDraft, replyTo: '444' }, context);
    assert.equal(result.status, 'uncertain');
  }
  const { api } = fixture({ post: { is_reply: true, replied_to: { id: '444' } } });
  assert.equal((await publishApiDraft(api, { ...baseDraft, replyTo: '444' }, context)).status, 'confirmed');
});

test('quote confirmation requires the exact quoted-post ID', async () => {
  const { api } = fixture({ post: { is_quote_post: true, quoted_post: { id: '777' } } });
  assert.equal((await publishApiDraft(api, { ...baseDraft, quotePostId: '444' }, context)).status, 'uncertain');
});

test('ordinary post does not confirm an unexpected reply or quote relationship', async () => {
  for (const post of [{ is_reply: true, replied_to: { id: '444' } }, { is_quote_post: true, quoted_post: { id: '444' } }]) {
    const { api } = fixture({ post });
    assert.equal((await publishApiDraft(api, baseDraft, context)).status, 'uncertain');
  }
});

test('stop observed after container creation prevents publication', async () => {
  const { api, actions } = fixture();
  const result = await publishApiDraft(api, baseDraft, context, { shouldStop: () => actions.some(action => action.kind === 'create_container') });
  assert.equal(result.status, 'failed');
  assert.equal(actions.filter(action => action.kind === 'publish_container').length, 0);
  assert.ok(result.evidence.some(item => item.includes('container')), 'Retain created container evidence');
});

test('media-only draft cannot confirm an unexpected nonempty caption', async () => {
  const { api } = fixture({ post: { media_type: 'IMAGE', media_url: 'https://cdn.example.com/image.jpg', text: 'Unapproved extra text' } });
  const result = await publishApiDraft(api, { ...baseDraft, text: undefined, media: [{ type: 'image', url: 'https://example.com/photo.jpg' }] }, context);
  assert.equal(result.status, 'uncertain');
});

test('carousel confirmation requires the authorized number of children', async () => {
  const { api } = fixture({ post: { media_type: 'CAROUSEL_ALBUM', children: { data: [{ id: '10', media_type: 'IMAGE', media_url: 'https://cdn.example.com/image.jpg' }] } } });
  const result = await publishApiDraft(api, { ...baseDraft, media: [
    { type: 'image', url: 'https://example.com/1.jpg' }, { type: 'image', url: 'https://example.com/2.jpg' },
  ] }, context);
  assert.equal(result.status, 'uncertain');
});

test('known publish preflight rejection remains failed while uncertain dispatch remains uncertain', async () => {
  for (const [outcome, expected] of [['not_sent', 'failed'], ['rejected', 'failed'], ['unknown', 'uncertain']] as const) {
    const { api, actions } = fixture({ publishError: new OfficialApiError('API_FIXTURE', 'Sanitized fixture failure', outcome) });
    const result = await publishApiDraft(api, baseDraft, context);
    assert.equal(result.status, expected);
    assert.equal(actions.filter(a => a.kind === 'publish_container').length, 1, 'Never retry a rejected or uncertain publish');
  }
});

test('readback rejection after confirmed publication remains uncertain and retains the post ID evidence', async () => {
  const { api } = fixture({ readbackError: new OfficialApiError('API_PERMISSION_REQUIRED', 'Fixture permission failure', 'rejected') });
  const result = await publishApiDraft(api, baseDraft, context);
  assert.equal(result.status, 'uncertain');
  assert.ok(result.evidence.some(item => item.includes('900')));
});
