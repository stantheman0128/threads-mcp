import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore, explicitIso, validateDraft, exportPosts, collectBatch, collectIncremental, type Publisher } from '../src/workflows.js';
import type { Post } from '../src/types.js';

const at = '2026-10-24T08:00:00+08:00', now = '2026-10-24T00:01:00Z';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'threads-workflows-'));
  const store = new WorkflowStore({ dataDir: dir, accountId: 'alice' });
  return { dir, store, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function post(id: string, text = 'hello'): Post {
  return { id, text, author: { username: 'alice' }, url: `https://www.threads.com/@alice/post/${id}`, createdAt: null,
    likes: null, replies: null, reposts: null, quotes: null, views: null, isReply: null, parentId: null, rootId: null,
    observedAt: now, source: 'browser-json', media: [] };
}
const confirmed: Publisher = async (_draft, ctx) => ({ status: 'confirmed', postId: `post-${ctx.partIndex}`, evidence: ['Observed resulting post.'] });

test('draft validation requires nonempty content, explicit timezone, bounded media and noncredential URLs', () => {
  assert.throws(() => validateDraft({ text: ' ' }), /needs text or media/);
  assert.throws(() => validateDraft({ text: 'x'.repeat(501) }), /500/);
  assert.throws(() => validateDraft({ media: [{ type: 'image', url: 'https://name:secret@example.com/x' }] }), /credentials/);
  assert.throws(() => validateDraft({ media: [{ type: 'image', path: 'relative.png' }] }), /absolute/);
  assert.throws(() => explicitIso('2026-10-24T08:00:00'), /timezone/);
  assert.throws(() => explicitIso('2026-02-30T08:00:00Z'), /invalid/);
  assert.equal(explicitIso(at), '2026-10-24T00:00:00.000Z');
  assert.equal(validateDraft({ text: '😀'.repeat(500) }).text?.length, 1000);
  assert.equal(validateDraft({ text: 'quote', quotePostId: '123456789' }).quotePostId, '123456789');
  assert.throws(() => validateDraft({ text: 'quote', quotePostId: 'not-numeric' }), /numeric/);
  assert.throws(() => validateDraft({ text: 'quote', quotePostId: '123', replyTo: '456' }), /reply and a quote/);
  assert.equal(validateDraft({text:'browser reply',replyUrl:'https://www.threads.com/@alice/post/ROOT'}).replyUrl,'https://www.threads.com/@alice/post/ROOT');
  assert.throws(()=>validateDraft({text:'reply',replyUrl:'https://evil.example/@alice/post/ROOT'}),/Threads HTTPS/);
  assert.throws(()=>validateDraft({text:'reply',replyUrl:'https://www.threads.com/@alice/post/ROOT',replyTo:'123'}),/one reply/);
  assert.throws(()=>validateDraft({text:'reply',replyUrl:'https://www.threads.com/@alice/post/ROOT',quotePostId:'123'}),/reply and a quote/);
});

test('browser chains receive only the previous confirmed permalink and reject later explicit reply targets',async()=>{
  const f=fixture();try{
    const first=f.store.saveDraft({text:'first'}),second=f.store.saveDraft({text:'second'});
    const targeted=f.store.saveDraft({text:'wrong second',replyUrl:'https://www.threads.com/@alice/post/OTHER'});
    assert.throws(()=>f.store.stageSchedule({draftIds:[first.id,targeted.id],at}),/Only the first/);
    const job=f.store.stageSchedule({draftIds:[first.id,second.id],at});f.store.authorizeSchedule(job.id);
    const contexts:any[]=[];
    const result=await f.store.runDue(async(_draft,ctx)=>{contexts.push(ctx);return {status:'confirmed',postId:`P${ctx.partIndex}`,postUrl:`https://www.threads.com/@alice/post/P${ctx.partIndex}`,evidence:['Fixture matched publication']};},{writesEnabled:true,now});
    assert.equal(result[0].status,'confirmed');assert.equal(contexts[0].previousPostUrl,undefined);
    assert.equal(contexts[1].previousPostUrl,'https://www.threads.com/@alice/post/P0');assert.equal(contexts[1].replyTo,'P0');
  }finally{f.cleanup();}
});

test('drafts persist, are account isolated, and schedule snapshots cannot change after authorization', async () => {
  const f = fixture(), other = new WorkflowStore({ dataDir: f.dir, accountId: 'bob' });
  try {
    const draft = f.store.saveDraft({ text: 'original' });
    assert.equal(other.getDraft(draft.id), undefined);
    assert.throws(() => other.stageSchedule({ draftIds: [draft.id], at }), /does not exist/);
    const job = f.store.stageSchedule({ draftIds: [draft.id], at });
    f.store.saveDraft({ text: 'edited' }, draft.id);
    const reopen = new WorkflowStore({ dataDir: f.dir, accountId: 'alice' });
    assert.equal(reopen.getDraft(draft.id)?.text, 'edited'); reopen.close();
    assert.equal((await f.store.runDue(confirmed, { writesEnabled: true, now })).length, 0);
    f.store.authorizeSchedule(job.id);
    await assert.rejects(f.store.runDue(confirmed, { writesEnabled: false, now }), /enabled write/);
    let body = '';
    const result = await f.store.runDue(async (d, ctx) => { body = d.text!; return confirmed(d, ctx); }, { writesEnabled: true, now });
    assert.equal(body, 'original'); assert.equal(result[0].status, 'confirmed');
    assert.deepEqual(await f.store.runDue(confirmed, { writesEnabled: true, now }), []);
  } finally { other.close(); f.cleanup(); }
});

test('dedupe keys reject changed prepared content and cancellation prevents due execution', async () => {
  const f = fixture();
  try {
    const draft = f.store.saveDraft({ text: 'hello' });
    const input = { draftIds: [draft.id], at, dedupeKey: 'calendar-1' };
    const job = f.store.stageSchedule(input);
    assert.equal(f.store.stageSchedule(input).id, job.id);
    f.store.saveDraft({ text: 'changed' }, draft.id);
    assert.throws(() => f.store.stageSchedule(input), /different prepared/);
    f.store.authorizeSchedule(job.id); f.store.cancelSchedule(job.id);
    assert.deepEqual(await f.store.runDue(confirmed, { writesEnabled: true, now }), []);
    assert.equal(f.store.getSchedule(job.id).status, 'cancelled');
  } finally { f.cleanup(); }
});

test('chains carry confirmed parent IDs and stop on uncertain effects without replay', async () => {
  const f = fixture();
  try {
    const ids = ['one', 'two', 'three'].map(text => f.store.saveDraft({ text }).id);
    const job = f.store.stageSchedule({ draftIds: ids, at }); f.store.authorizeSchedule(job.id);
    const calls: Array<{ index: number; parent?: string }> = [];
    const outcome = await f.store.runDue(async (_draft, context) => {
      calls.push({ index: context.partIndex, parent: context.replyTo });
      return context.partIndex === 0 ? { status: 'confirmed', postId: 'first-post', evidence: ['Observed first post.'] } :
        { status: 'uncertain', evidence: ['Connection lost after dispatch.'] };
    }, { writesEnabled: true, now });
    assert.deepEqual(calls, [{ index: 0, parent: undefined }, { index: 1, parent: 'first-post' }]);
    assert.equal(outcome[0].status, 'uncertain'); assert.equal(outcome[0].parts[2].status, 'pending');
    assert.deepEqual(await f.store.runDue(confirmed, { writesEnabled: true, now }), []);
    assert.throws(() => f.store.authorizeSchedule(job.id), /Only a staged/);
    const reconciled = f.store.reconcileSchedule(job.id, { status: 'confirmed', postId: 'second-post', evidence: ['Read back second post from account.'] });
    assert.equal(reconciled.status, 'staged');
    f.store.authorizeSchedule(job.id);
    const rest = await f.store.runDue(async (d, ctx) => {
      assert.equal(ctx.partIndex, 2); assert.equal(ctx.replyTo, 'second-post'); return confirmed(d, ctx);
    }, { writesEnabled: true, now });
    assert.equal(rest[0].status, 'confirmed');
  } finally { f.cleanup(); }
});

test('thrown or evidence-free publication outcomes become uncertain, never retried', async () => {
  const f = fixture();
  try {
    for (const publisher of [async () => { throw new Error('sensitive detail'); }, async () => ({ status: 'confirmed', postId: '', evidence: [] })]) {
      const job = f.store.stageSchedule({ draftIds: [f.store.saveDraft({ text: 'hello' }).id], at }); f.store.authorizeSchedule(job.id);
      const [result] = await f.store.runDue(publisher as Publisher, { writesEnabled: true, now });
      assert.equal(result.status, 'uncertain'); assert.ok(!JSON.stringify(result).includes('sensitive detail'));
    }
    assert.deepEqual(await f.store.runDue(confirmed, { writesEnabled: true, now }), []);
  } finally { f.cleanup(); }
});

test('concurrent stores claim once and opening another store preserves a live runner', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const job = f.store.stageSchedule({ draftIds: [f.store.saveDraft({ text: 'hello' }).id], at }); f.store.authorizeSchedule(job.id);
    const running = f.store.runDue(async (d, ctx) => { await gate; return confirmed(d, ctx); }, { writesEnabled: true, now });
    const other = new WorkflowStore({ dataDir: f.dir, accountId: 'alice' });
    try {
      assert.equal(other.getSchedule(job.id).status, 'running');
      assert.deepEqual(await other.runDue(confirmed, { writesEnabled: true, now }), []);
      release(); assert.equal((await running)[0].status, 'confirmed');
    } finally { other.close(); }
  } finally { release(); f.cleanup(); }
});

test('cancelling an active chain preserves the already dispatched result and stops subsequent parts', async () => {
  const f = fixture();
  try {
    const job = f.store.stageSchedule({ draftIds: ['one', 'two'].map(text => f.store.saveDraft({ text }).id), at }); f.store.authorizeSchedule(job.id);
    const results = await f.store.runDue(async (d, ctx) => { f.store.cancelSchedule(job.id); return confirmed(d, ctx); }, { writesEnabled: true, now });
    assert.equal(results[0].status, 'cancelled'); assert.equal(results[0].parts[0].status, 'confirmed'); assert.equal(results[0].parts[1].status, 'pending');
  } finally { f.cleanup(); }
});

test('cancelling an uncertain chain preserves uncertainty and prevents continuation after reconciliation', async () => {
  const f = fixture();
  try {
    const job = f.store.stageSchedule({ draftIds: ['one', 'two'].map(text => f.store.saveDraft({ text }).id), at }); f.store.authorizeSchedule(job.id);
    await f.store.runDue(async () => ({ status: 'uncertain', evidence: ['Readback missing.'] }), { writesEnabled: true, now });
    assert.equal(f.store.cancelSchedule(job.id).status, 'uncertain');
    const settled = f.store.reconcileSchedule(job.id, { status: 'confirmed', postId: 'actual-post', evidence: ['Readback found original post.'] });
    assert.equal(settled.status, 'cancelled'); assert.equal(settled.parts[1].status, 'pending');
  } finally { f.cleanup(); }
});

test('dead process in-flight claims recover uncertain after restart', () => {
  const f = fixture();
  try {
    const job = f.store.stageSchedule({ draftIds: [f.store.saveDraft({ text: 'hello' }).id], at });
    job.status = 'running'; job.parts[0].status = 'publishing'; job.ownerPid = 2147483647;
    const db = new DatabaseSync(join(f.dir, 'workflows.sqlite'));
    db.prepare('UPDATE workflow_jobs SET status=?,payload=? WHERE id=?').run('running', JSON.stringify(job), job.id); db.close();
    const reopened = new WorkflowStore({ dataDir: f.dir, accountId: 'alice' });
    try { assert.equal(reopened.getSchedule(job.id).status, 'uncertain'); assert.equal(reopened.getSchedule(job.id).parts[0].status, 'uncertain'); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('dead process between chain parts restages only remaining content and needs fresh authorization', async () => {
  const f = fixture();
  try {
    const job = f.store.stageSchedule({ draftIds: ['first', 'second'].map(text => f.store.saveDraft({ text }).id), at });
    job.status = 'running'; job.ownerPid = 2147483647;
    job.parts[0].status = 'confirmed'; job.parts[0].outcome = { status: 'confirmed', postId: 'first-id', evidence: ['Observed first post.'] };
    const db = new DatabaseSync(join(f.dir, 'workflows.sqlite'));
    db.prepare('UPDATE workflow_jobs SET status=?,payload=? WHERE id=?').run('running', JSON.stringify(job), job.id); db.close();
    const reopened = new WorkflowStore({ dataDir: f.dir, accountId: 'alice' });
    try {
      assert.equal(reopened.getSchedule(job.id).status, 'staged');
      assert.deepEqual(await reopened.runDue(confirmed, { writesEnabled: true, now }), []);
      reopened.authorizeSchedule(job.id);
      const result = await reopened.runDue(async (d, ctx) => { assert.equal(ctx.partIndex, 1); assert.equal(ctx.replyTo, 'first-id'); return confirmed(d, ctx); }, { writesEnabled: true, now });
      assert.equal(result[0].status, 'confirmed');
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('CSV exports quote embedded lines and defend spreadsheet formula injection; JSON preserves null', () => {
  const csv = exportPosts([post('1', '=HYPERLINK("bad")\nline'), post('2', ' \t+SUM(1,2)')], 'csv');
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")\nline"'));
  assert.ok(csv.includes('"\' \t+SUM(1,2)"'));
  const json = JSON.parse(exportPosts([post('1')], 'json'));
  assert.equal(json.items[0].likes, null); assert.equal(json.completeness, 'observed-window-only');
});

test('incremental collection commits before advancing checkpoint and retains source completeness', async () => {
  const saved: string[] = [];
  const result = await collectIncremental({ maxPages: 2, maxItems: 10,
    fetchPage: async cursor => cursor === null ? { items: [post('1')], nextCursor: 'next', completeness: 'partial' } :
      { items: [post('1'), post('2')], nextCursor: null, completeness: 'unknown' },
    onPage: async (items, checkpoint) => { saved.push(`${items.map(p => p.id)}:${checkpoint.cursor}`); }
  });
  assert.deepEqual(result.items.map(p => p.id), ['1', '2']); assert.equal(result.completeness, 'unknown');
  assert.deepEqual(saved, ['1:next', '2:null']); assert.equal(result.checkpoint.observedItems, 2);
  await assert.rejects(collectIncremental({ fetchPage: async () => ({ items: [post('1')], nextCursor: 'next', completeness: 'partial' }), onPage: async () => { throw new Error('index unavailable'); } }), /index unavailable/);
});

test('incremental bounds and cursor loops are visible; oversized pages do not skip uncommitted posts', async () => {
  const result = await collectIncremental({ maxPages: 1, fetchPage: async () => ({ items: [post('1')], nextCursor: 'more', completeness: 'partial' }) });
  assert.equal(result.checkpoint.cursor, 'more'); assert.equal(result.completeness, 'partial'); assert.match(result.warnings[0], /bound/);
  const loop = await collectIncremental({ fetchPage: async () => ({ items: [post('1')], nextCursor: 'same', completeness: 'partial' }) });
  assert.equal(loop.pages, 2); assert.ok(loop.warnings.some(w => /repeated/.test(w)));
  await assert.rejects(collectIncremental({ maxItems: 1, fetchPage: async () => ({ items: [post('1'), post('2')], nextCursor: null, completeness: 'partial' }) }), /exceeded/);
});

test('batch collection is bounded, deduplicated, and reports individual failures safely', async () => {
  const result = await collectBatch(['alice', 'bob', 'alice'], async target => { if (target === 'bob') throw new Error('token=secret'); return 1; });
  assert.deepEqual(result, [{ target: 'alice', status: 'ok', result: 1 }, { target: 'bob', status: 'failed', error: 'COLLECTION_FAILED' }]);
  await assert.rejects(collectBatch(Array.from({ length: 21 }, (_, i) => String(i)), async () => 1), /1 to 20/);
});
