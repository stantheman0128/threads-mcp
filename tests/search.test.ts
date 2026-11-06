import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, classifyMentionText, type SearchIndexOptions } from '../src/search.js';
import type { Post } from '../src/types.js';

function post(id: string, text: string, overrides: Partial<Post> = {}): Post {
  return { id, url: `https://www.threads.com/@sample/post/${id}`, author: { username: 'sample' }, text,
    createdAt: '2026-10-22T12:00:00Z', observedAt: '2026-10-23T12:00:00Z', likes: null,
    replies: null, reposts: null, quotes: null, views: null, isReply: false, parentId: null, rootId: null,
    media: [], source: 'browser-json', ...overrides };
}

function temporary(options: SearchIndexOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'threads-search-'));
  const index = new SearchIndex(dir, options);
  return { index, dir, cleanup: () => { index.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const fakeEmbedder = async (texts: string[]) => texts.map(text => /automobile|car|汽車/u.test(text) ? [1, 0, 0] :
  /coffee|咖啡/u.test(text) ? [0, 1, 0] : [0, 0, 1]);

test('Chinese lexical phrases and Latin transposition typos rank relevant posts', async () => {
  const { index, cleanup } = temporary();
  try {
    index.upsert([post('zh', '台北有很多適合工作的咖啡店'), post('en', 'Build a browser automation agent'), post('other', 'Cooking pasta')]);
    const chinese = await index.search('咖啡店', { mode: 'lexical' });
    assert.equal(chinese.items[0].post.id, 'zh');
    const typo = await index.search('borwser', { mode: 'lexical' });
    assert.equal(typo.items[0].post.id, 'en');
    assert.equal(typo.items[0].semanticScore, null);
    assert.equal(typo.method, 'lexical-word-bigram-typo');
  } finally { cleanup(); }
});

test('semantic search retrieves nonoverlapping synonyms and cross-language matches', async () => {
  const { index, cleanup } = temporary({ embedder: fakeEmbedder, embeddingModel: 'fixture-v1' });
  try {
    index.upsert([post('car', '汽車維修'), post('coffee', 'coffee shop'), post('other', 'pottery')]);
    const lexical = await index.search('automobile', { mode: 'lexical' });
    assert.equal(lexical.items.length, 0);
    const semantic = await index.search('automobile', { mode: 'semantic', limit: 1 });
    assert.equal(semantic.items[0].post.id, 'car');
    assert.equal(semantic.items[0].lexicalScore, 0);
    assert.equal(semantic.items[0].semanticScore, 1);
    assert.equal(semantic.method, 'semantic-multilingual-embeddings');
  } finally { cleanup(); }
});

test('persistence reuses embeddings, updates metrics and invalidates changed text', async () => {
  let calls = 0;
  const options = { embeddingModel: 'fixture-v1', embedder: async (texts: string[]) => { calls++; return fakeEmbedder(texts); } };
  const { index, dir, cleanup } = temporary(options);
  let reopened: SearchIndex | undefined;
  try {
    index.upsert([post('one', 'car', { likes: 4 })]);
    await index.search('automobile', { mode: 'semantic' });
    const initialCalls = calls;
    index.close();
    reopened = new SearchIndex(dir, options);
    assert.equal(reopened.stats().posts, 1);
    const result = await reopened.search('automobile', { mode: 'semantic' });
    assert.equal(result.items[0].post.likes, 4);
    assert.equal(calls, initialCalls);
    reopened.upsert([post('one', 'car', { likes: null, observedAt: '2026-10-23T13:00:00Z' })]);
    assert.equal((await reopened.search('automobile', { mode: 'semantic' })).items[0].post.likes, null);
    assert.equal(calls, initialCalls);
    reopened.upsert([post('one', 'coffee', { observedAt: '2026-10-23T14:00:00Z' })]);
    const changed = await reopened.search('automobile', { mode: 'semantic' });
    assert.equal(changed.items[0].semanticScore, 0);
    assert.ok(calls > initialCalls);
  } finally { reopened?.close(); cleanup(); }
});

test('older observations cannot overwrite newer posts; unknown likes fail numeric filter', async () => {
  const { index, cleanup } = temporary();
  try {
    index.upsert([post('null', 'coffee'), post('zero', 'coffee', { likes: 0 }), post('new', 'coffee', { likes: 10 })]);
    index.upsert([post('new', 'stale', { likes: 1, observedAt: '2026-10-22T12:00:00Z' })]);
    const result = await index.search('coffee', { mode: 'lexical', minLikes: 0, author: '@SAMPLE', since: '2026-10-22' });
    assert.deepEqual(result.items.map(item => item.post.id).sort(), ['new', 'zero']);
    assert.equal(result.items.find(item => item.post.id === 'new')?.post.likes, 10);
    assert.equal((await index.search('coffee', { mode: 'lexical', since: '2026-10-23' })).items.length, 0);
  } finally { cleanup(); }
});

test('all corpus pages are scanned, embedding batches bounded, and long-post tails included', async () => {
  let largestBatch = 0;
  let sawTail = false;
  const { index, cleanup } = temporary({ batchSize: 2, embedder: async texts => {
    largestBatch = Math.max(largestBatch, texts.length);
    sawTail ||= texts.some(text => text.includes('automobile'));
    return fakeEmbedder(texts);
  } });
  try {
    index.upsert(Array.from({ length: 300 }, (_, i) => post(String(i), `unrelated ${i}`)));
    index.upsert([post('last', `${'x'.repeat(200)} automobile`)]);
    const result = await index.search('automobile', { mode: 'hybrid', limit: 1 });
    assert.equal(result.corpusSize, 301);
    assert.equal(result.items[0].post.id, 'last');
    assert.ok(largestBatch <= 2);
    assert.ok(sawTail);
    const lexical = await index.search('automobile', { mode: 'lexical', limit: 1 });
    assert.equal(lexical.items[0].post.id, 'last');
  } finally { cleanup(); }
});

test('embedding failures explicitly fall back and rerank the whole corpus', async () => {
  const { index, cleanup } = temporary({ embedder: async texts => {
    if (texts.includes('broken')) throw new Error('private failure details');
    return fakeEmbedder(texts);
  } });
  try {
    index.upsert([post('car', 'car'), post('broken', 'broken'), post('exact', 'automobile')]);
    const result = await index.search('automobile', { mode: 'hybrid' });
    assert.equal(result.method, 'lexical-fallback');
    assert.equal(result.items[0].post.id, 'exact');
    assert.ok(result.items.every(hit => hit.semanticScore === null));
    assert.ok(result.warnings.some(warning => warning.includes('no semantic ranking')));
    assert.ok(!JSON.stringify(result).includes('private failure details'));
  } finally { cleanup(); }
});

test('strict semantic mode exposes a controlled error when embeddings fail', async () => {
  const { index, cleanup } = temporary({ fallbackOnError: false, embedder: async () => { throw new Error('internal'); } });
  try {
    index.upsert([post('one', 'car')]);
    await assert.rejects(index.search('automobile', { mode: 'semantic' }), { code: 'EMBEDDINGS_UNAVAILABLE' });
  } finally { cleanup(); }
});

test('different models do not reuse cached vectors', async () => {
  const { index, dir, cleanup } = temporary({ embedder: fakeEmbedder, embeddingModel: 'one' });
  let reopened: SearchIndex | undefined;
  try {
    index.upsert([post('one', 'car')]);
    await index.search('automobile', { mode: 'semantic' });
    index.close();
    let calls = 0;
    reopened = new SearchIndex(dir, { embeddingModel: 'two', embedder: async texts => { calls++; return fakeEmbedder(texts); } });
    await reopened.search('automobile', { mode: 'semantic' });
    assert.ok(calls >= 2);
  } finally { reopened?.close(); cleanup(); }
});

test('empty corpus never loads a model and validation rejects invalid filters', async () => {
  const { index, cleanup } = temporary({ embedder: async () => { assert.fail('no model for empty corpus'); } });
  try {
    const result = await index.search('hello', { mode: 'semantic' });
    assert.equal(result.items.length, 0);
    assert.ok(result.warnings.some(warning => warning.includes('empty')));
    await assert.rejects(index.search('', { mode: 'lexical' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hi', { mode: 'lexical', since: 'invalid' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hi', { mode: 'lexical', limit: 0 }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hi', { mode: 'lexical', minLikes: NaN }), { code: 'INVALID_ARGUMENT' });
  } finally { cleanup(); }
});

test('collection filters OR scopes without leaking unrelated same-word posts in any ranking mode', async () => {
  const { index, cleanup } = temporary({ embedder: fakeEmbedder });
  try {
    index.upsert([post('outside', 'coffee')]);
    index.recordCollection('liked', [post('liked', 'coffee')]);
    index.recordCollection('saved', [post('saved', 'coffee'), post('liked', 'coffee')]);
    index.recordCollection('profile:sample:replies', [post('reply', 'coffee', { isReply: true })]);
    for (const mode of ['lexical', 'semantic', 'hybrid'] as const) {
      const result = await index.search('coffee', { mode, collections: ['LIKED', 'saved'] });
      assert.deepEqual(result.items.map(item => item.post.id).sort(), ['liked', 'saved']);
      assert.equal(result.corpusSize, 4);
      assert.deepEqual(result.items.find(item => item.post.id === 'liked')?.observedCollections?.map(item => item.collection), ['liked', 'saved']);
    }
    assert.equal((await index.search('coffee', { mode: 'lexical' })).items.length, 4);
    assert.equal((await index.search('coffee', { mode: 'semantic', collections: [] })).items.length, 0);
    assert.equal((await index.search('coffee', { mode: 'lexical', collections: ['missing'] })).items.length, 0);
    const replies = await index.search('coffee', { mode: 'lexical', collections: ['profile:sample:replies'] });
    assert.deepEqual(replies.items.map(item => item.post.id), ['reply']);
  } finally { cleanup(); }
});

test('partial collection refresh retains unseen historical membership across restart and tracks observation bounds', async () => {
  const { index, dir, cleanup } = temporary();
  let reopened: SearchIndex | undefined;
  try {
    index.recordCollection('liked', [post('one', 'coffee'), post('two', 'coffee')]);
    index.recordCollection('liked', [post('one', 'coffee updated', { likes: 9, observedAt: '2026-10-24T12:00:00Z' })]);
    index.recordCollection('liked', []);
    index.recordCollection('liked', [post('one', 'stale', { likes: 1, observedAt: '2026-10-22T12:00:00Z' })]);
    index.close();
    reopened = new SearchIndex(dir);
    const result = await reopened.search('coffee', { mode: 'lexical', collections: ['liked'] });
    assert.deepEqual(result.items.map(item => item.post.id).sort(), ['one', 'two']);
    const one = result.items.find(item => item.post.id === 'one')!;
    assert.equal(one.post.likes, 9);
    assert.equal(one.post.text, 'coffee updated');
    assert.deepEqual(one.observedCollections, [{ collection: 'liked', firstObservedAt: '2026-10-22T12:00:00.000Z', lastObservedAt: '2026-10-24T12:00:00.000Z' }]);
    assert.ok(result.warnings.some(warning => warning.includes('does not prove') && warning.includes('currently liked or saved')));
  } finally { reopened?.close(); cleanup(); }
});

test('inclusive date bounds exclude unknown dates and reply filters conservatively exclude unknown classification', async () => {
  const { index, cleanup } = temporary();
  try {
    index.upsert([
      post('start', 'coffee', { createdAt: '2026-10-22T00:00:00Z', isReply: true }),
      post('end', 'coffee', { createdAt: '2026-10-23T00:00:00Z', isReply: false }),
      post('after', 'coffee', { createdAt: '2026-10-23T00:00:00.001Z', isReply: true }),
      post('before', 'coffee', { createdAt: '2026-10-21T23:59:59Z', isReply: false }),
      post('unknown-date', 'coffee', { createdAt: null, isReply: true }),
      post('unknown-reply', 'coffee', { createdAt: '2026-10-22T12:00:00Z', isReply: null }),
    ]);
    const range = { mode: 'lexical' as const, since: '2026-10-22T00:00:00Z', until: '2026-10-23T00:00:00Z' };
    assert.deepEqual((await index.search('coffee', range)).items.map(item => item.post.id).sort(), ['end', 'start', 'unknown-reply']);
    assert.deepEqual((await index.search('coffee', { ...range, onlyReplies: true })).items.map(item => item.post.id), ['start']);
    assert.deepEqual((await index.search('coffee', { ...range, onlyReplies: false })).items.map(item => item.post.id), ['end']);
    assert.ok(!(await index.search('coffee', { mode: 'lexical', until: range.until })).items.some(item => item.post.id === 'unknown-date'));
  } finally { cleanup(); }
});

test('excluded terms use normalized case-insensitive exact substrings rather than fuzzy matches', async () => {
  const { index, cleanup } = temporary({ embedder: fakeEmbedder });
  try {
    index.recordCollection('saved', [post('ad', 'coffee ＳＰＯＮＳＯＲＥＤ edition'), post('organic', 'coffee sponsor-free'), post('zh', 'coffee 這是業配推薦')]);
    for (const mode of ['lexical', 'semantic', 'hybrid'] as const) {
      const result = await index.search('coffee', { mode, collections: ['saved'], excludeTerms: ['sponsored', '業配'] });
      assert.deepEqual(result.items.map(item => item.post.id), ['organic']);
    }
  } finally { cleanup(); }
});

test('additive migration preserves legacy posts and embedding cache without inventing collections', async () => {
  const options = { embedder: fakeEmbedder, embeddingModel: 'migration-fixture' };
  const { index, dir, cleanup } = temporary(options);
  let reopened: SearchIndex | undefined;
  try {
    index.upsert([post('legacy', 'car')]);
    await index.search('automobile', { mode: 'semantic' });
    const before = index.stats();
    index.close();
    // Recreate the previous schema by removing only the new fixture table.
    const legacyDb = new DatabaseSync(join(dir, 'search.sqlite'));
    legacyDb.exec('DROP TABLE collection_memberships');
    legacyDb.close();
    reopened = new SearchIndex(dir, options);
    assert.deepEqual(reopened.stats(), before);
    const result = await reopened.search('automobile', { mode: 'semantic' });
    assert.equal(result.items[0].post.id, 'legacy');
    assert.equal(result.items[0].observedCollections, undefined);
    assert.equal((await reopened.search('car', { mode: 'lexical', collections: ['liked'] })).items.length, 0);
    reopened.recordCollection('liked', [post('legacy', 'car')]);
    assert.equal((await reopened.search('car', { mode: 'lexical', collections: ['liked'] })).items.length, 1);
  } finally { reopened?.close(); cleanup(); }
});

test('collection writes are atomic and advanced filter validation fails clearly', async () => {
  const { index, cleanup } = temporary();
  try {
    assert.throws(() => index.recordCollection('liked', [post('valid', 'coffee'), post('invalid', 'coffee', { observedAt: 'bad-date' })]), { code: 'INVALID_POST' });
    assert.equal(index.stats().posts, 0);
    assert.throws(() => index.recordCollection('', []), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('coffee', { mode: 'lexical', until: 'bad-date' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('coffee', { mode: 'lexical', since: '2026-10-24', until: '2026-10-23' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('coffee', { mode: 'lexical', collections: [''] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('coffee', { mode: 'lexical', excludeTerms: [''] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('coffee', { mode: 'lexical', onlyReplies: 'true' as unknown as boolean }), { code: 'INVALID_ARGUMENT' });
  } finally { cleanup(); }
});

test('explicit membership correction preserves posts, embeddings, other collections and unlisted members', async () => {
  const options = { embedder: fakeEmbedder, embeddingModel: 'correction-fixture' };
  const { index, dir, cleanup } = temporary(options);
  let reopened: SearchIndex | undefined;
  try {
    const posts = [post('root', 'coffee'), post('reply', 'coffee', { isReply: true })];
    index.recordCollection('account:sample:posts', posts);
    index.recordCollection('saved', posts);
    await index.search('coffee', { mode: 'semantic' });
    const before = index.stats();
    assert.equal(index.removeCollectionMembers('account:sample:posts', ['reply', 'reply', 'absent']), 1);
    assert.equal(index.removeCollectionMembers('account:sample:posts', []), 0);
    assert.equal(index.removeCollectionMembers('account:sample:posts', ['reply']), 0);
    assert.deepEqual(index.stats(), before);
    assert.deepEqual((await index.search('coffee', { mode: 'lexical', collections: ['account:sample:posts'] })).items.map(hit => hit.post.id), ['root']);
    assert.deepEqual((await index.search('coffee', { mode: 'lexical', collections: ['saved'] })).items.map(hit => hit.post.id).sort(), ['reply', 'root']);
    assert.equal((await index.search('coffee', { mode: 'lexical' })).items.length, 2);
    assert.throws(() => index.removeCollectionMembers('saved', ['root', '']), { code: 'INVALID_ARGUMENT' });
    assert.equal((await index.search('coffee', { mode: 'lexical', collections: ['saved'] })).items.length, 2);
    index.close();
    reopened = new SearchIndex(dir, options);
    assert.deepEqual(reopened.stats(), before);
    const result = await reopened.search('coffee', { mode: 'semantic' });
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.find(hit => hit.post.id === 'reply')?.observedCollections?.map(item => item.collection), ['saved']);
  } finally { reopened?.close(); cleanup(); }
});

test('author diversity is enforced during full-corpus ranking rather than after a top-100 cutoff', async () => {
  const { index, cleanup } = temporary({ embedder: fakeEmbedder });
  try {
    index.upsert(Array.from({ length: 180 }, (_, i) => post(`majority-${String(i).padStart(3, '0')}`, 'coffee', { author: { username: i % 2 ? 'ALICE' : 'alice' } })));
    index.upsert([post('minority', 'coffee', { author: { username: 'bob' } })]);
    for (const mode of ['lexical', 'semantic', 'hybrid'] as const) {
      const ranked = await index.search('coffee', { mode, limit: 2, maxPerAuthor: 1 });
      assert.equal(ranked.corpusSize, 181);
      assert.equal(ranked.items.length, 2);
      assert.deepEqual(ranked.items.map(hit => hit.post.author.username.toLowerCase()).sort(), ['alice', 'bob']);
      assert.ok(ranked.items.some(hit => hit.post.id === 'minority'));
    }
  } finally { cleanup(); }
});

test('a later higher-ranked candidate replaces the same author without dropping another author', async () => {
  const { index, cleanup } = temporary();
  try {
    index.upsert([post('alice-low', 'cofee', { author: { username: 'alice' } }),
      post('bob', 'coffee', { author: { username: 'bob' } }),
      post('alice-best', 'coffee', { author: { username: 'ALICE' } })]);
    const result = await index.search('coffee', { mode: 'lexical', limit: 2, maxPerAuthor: 1 });
    assert.deepEqual(result.items.map(hit => hit.post.id).sort(), ['alice-best', 'bob']);
    assert.ok(result.items.every(hit => hit.score === 1));
  } finally { cleanup(); }
});

test('mention classifier enforces exact dotted handle boundaries and separately labels normalized brand matches', () => {
  assert.deepEqual(classifyMentionText('謝謝@Stan.Foo 協助 Stan Studio', '@stan.foo', ['Stan Studio']),
    { kind: 'explicit-handle', matchedTerms: ['@stan.foo', 'Stan Studio'] });
  for (const text of ['email@stan.foo', '@@stan.foo', 'local+@stan.foo', '@stanXfoo', '@stan.foo.bar', '@stan.foo_extra']) {
    assert.equal(classifyMentionText(text, 'stan.foo'), null, text);
  }
  assert.deepEqual(classifyMentionText('分享 ＳＴＡＮ ＳＴＵＤＩＯ 產品', 'stan.foo', ['stan studio']),
    { kind: 'name-or-brand-candidate', matchedTerms: ['stan studio'] });
  assert.equal(classifyMentionText('unrelated', 'stan.foo', ['Stan Studio']), null);
});

test('mention eligibility and explicit-handle priority happen before top-k across more than 100 candidates', async () => {
  const embedded: string[] = [];
  const { index, cleanup } = temporary({ embedder: async texts => {
    embedded.push(...texts);
    return texts.map(text => text.startsWith('謝謝') ? [0, 1] : [1, 0]);
  } });
  try {
    index.upsert(Array.from({ length: 160 }, (_, i) => post(`brand-${i}`, `Stan Studio candidate ${i}`, { author: { username: `brand${i}` } })));
    index.upsert(Array.from({ length: 160 }, (_, i) => post(`unrelated-${i}`, `unrelated ${i}`)));
    index.upsert(Array.from({ length: 160 }, (_, i) => post(`self-${i}`, `@stan.foo own mention ${i}`, { author: { username: 'STAN.FOO' } })));
    index.upsert([post('exact', '謝謝@stan.foo 幫忙', { author: { username: 'other' } })]);
    const result = await index.search('@stan.foo', { mode: 'semantic', limit: 2,
      mentionFilter: { username: '@stan.foo', terms: ['Stan Studio'], excludeSelf: true } });
    assert.equal(result.corpusSize, 481);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].post.id, 'exact');
    assert.equal(result.items[0].score, 0); // Priority changes order, never the actual similarity score.
    assert.equal(result.items[1].score, 1);
    assert.ok(!embedded.some(text => text.startsWith('unrelated') || text.includes('own mention')));
    assert.ok(result.items.every(hit => !('mentionPriority' in hit)));
    const includedSelf = await index.search('@stan.foo', { mode: 'semantic', limit: 1,
      mentionFilter: { username: 'stan.foo', excludeSelf: false } });
    assert.equal(includedSelf.items[0].post.author.username, 'STAN.FOO');
  } finally { cleanup(); }
});

test('eligible brand mentions survive zero lexical scores and embedding fallback', async () => {
  const { index, cleanup } = temporary({ embedder: async () => { throw new Error('offline'); } });
  try {
    index.upsert([post('brand', 'Stan Studio product'), post('unrelated', 'another product'), post('exact', '謝謝@stan.foo')]);
    const result = await index.search('@stan.foo', { mode: 'hybrid', mentionFilter: { username: 'stan.foo', terms: ['Stan Studio'] } });
    assert.equal(result.method, 'lexical-fallback');
    assert.deepEqual(result.items.map(hit => hit.post.id), ['exact', 'brand']);
    assert.equal(result.items[1].lexicalScore, 0);
    assert.equal(result.items[1].score, 0);
    assert.ok(result.items.every(hit => hit.semanticScore === null));
  } finally { cleanup(); }
});

test('mention and author-diversity options reject invalid values before model work', async () => {
  const { index, cleanup } = temporary();
  try {
    await assert.rejects(index.search('hello', { mode: 'lexical', maxPerAuthor: 0 }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hello', { mode: 'lexical', maxPerAuthor: 1.5 }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hello', { mode: 'lexical', mentionFilter: { username: 'bad name' } }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hello', { mode: 'lexical', mentionFilter: { username: 'stan', terms: [''] } }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(index.search('hello', { mode: 'lexical', mentionFilter: { username: 'stan', excludeSelf: 'true' as unknown as boolean } }), { code: 'INVALID_ARGUMENT' });
  } finally { cleanup(); }
});
