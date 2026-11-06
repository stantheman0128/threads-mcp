import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RemoteWorkflowController } from '../src/remote-workflows.js';
import { ThreadsService } from '../src/service.js';
import type { BrowserDriver } from '../src/driver.js';
import type { RemoteSocialController } from '../src/remote-social.js';
import type { RemoteMediaController } from '../src/remote-media.js';
import type { SearchIndex } from '../src/search.js';
import { getConfig } from '../src/config.js';
import { ThreadsError } from '../src/types.js';

const accountId = 'fixture', at = '2020-01-01T00:00:00Z';
const rejects = (value: Promise<unknown>, code: string) => assert.rejects(value, (error: unknown) => error instanceof ThreadsError && error.code === code);
function fixture(withMedia = false) {
  const dir = mkdtempSync(join(tmpdir(), 'threads-remote-workflow-'));
  let viewer = accountId, url = 'https://www.threads.com/', denied = false, mediaValid = true, uncertain = false, draftPresent = false;
  const commands: any[] = [], preparations: any[] = [], executions: any[] = [], observed: any[] = [];
  let prepareHook: (() => Promise<void>) | undefined, executeHook: (() => Promise<void>) | undefined, waitHook: (() => Promise<void>) | undefined;
  const raw = { command: async <T>(command: any): Promise<T> => {
    commands.push(command);
    if (command.type === 'navigate') { url = command.url; return {} as T; }
    if (command.type === 'read') return { url, viewer: { username: viewer }, composerState: { present: draftPresent, nonempty: draftPresent, attachments: false, ambiguous: false }, posts: observed } as T;
    throw new Error('Workflow called forbidden raw command');
  } } as BrowserDriver;
  const service = new ThreadsService(raw, {} as SearchIndex, { ...getConfig(), dataDir: dir, writesEnabled: true, minActionIntervalMs: 0 });
  service.waitForWriteSlot = async options => { options?.shouldStop?.(); await waitHook?.(); options?.shouldStop?.(); };
  const social = { prepare: async (request: any) => {
    preparations.push(structuredClone(request)); await prepareHook?.();
    return { id: randomUUID(), account: viewer, request, published: false };
  }, execute: async (id: string, expectedAccount: string) => {
    executions.push({ id, expectedAccount }); await executeHook?.();
    const request = preparations.at(-1), postUrl = `https://www.threads.com/@${accountId}/post/P${executions.length}`;
    if (uncertain) return { outcome: 'outcome-uncertain', verified: false, dispatch: { dispatched: true, noop: false } };
    return { outcome: 'verified', verified: true, dispatch: { dispatched: true, noop: false }, after: { account: viewer, targetUrl: request.targetUrl, postUrl, verified: true } };
  } } as unknown as RemoteSocialController;
  const media = withMedia ? { authorize: () => { if (!mediaValid) throw new ThreadsError('REMOTE_MEDIA_NOT_AUTHORIZED', 'Expired media token'); } } as unknown as RemoteMediaController : undefined;
  const access = () => { if (denied) throw new ThreadsError('REMOTE_WRITE_REVOKED', 'Private access detail'); };
  let controller = new RemoteWorkflowController(service, raw, social, access, media);
  return { dir, commands, preparations, executions, observed, get controller() { return controller; }, service,
    viewer: (value: string) => { viewer = value; }, deny: () => { denied = true; }, mediaExpire: () => { mediaValid = false; }, uncertain: (value = true) => { uncertain = value; }, draft: () => { draftPresent = true; },
    prepareHook: (value: typeof prepareHook) => { prepareHook = value; }, executeHook: (value: typeof executeHook) => { executeHook = value; }, waitHook: (value: typeof waitHook) => { waitHook = value; },
    restart: () => { controller.close(); controller = new RemoteWorkflowController(service, raw, social, access, media); },
    close: () => { controller.close(); assert.equal(dirname(dir), tmpdir()); rmSync(dir, { recursive: true, force: true }); },
  };
}
async function stage(f: ReturnType<typeof fixture>, texts = ['one']) {
  const drafts = [];
  for (const text of texts) drafts.push(await f.controller.saveDraft({ accountId, draft: { text } }));
  const job = await f.controller.stageSchedule({ accountId, draftIds: drafts.map(draft => draft.id), at }); return { drafts, job };
}

test('remote workflow immutable snapshots require separate authorization and explicit run', async () => {
  const f = fixture(); try {
    const { drafts, job } = await stage(f);
    await f.controller.saveDraft({ accountId, id: drafts[0].id, draft: { text: 'edited later' } });
    assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    assert.equal(f.preparations.length, 0);
    await f.controller.authorizeSchedule({ accountId, id: job.id });
    assert.equal(f.preparations.length, 0);
    const result = await f.controller.runSchedules({ accountId });
    assert.equal(result.jobs[0].status, 'confirmed'); assert.equal(f.preparations[0].text, 'one'); assert.equal(f.executions.length, 1);
    assert.equal(result.jobs[0].ownerPid, undefined); assert.equal(result.jobs[0].ownerToken, undefined);
    assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    assert.equal((await f.controller.deleteDraft({ accountId, id: drafts[0].id })).deleted, true);
    assert.deepEqual(await f.controller.listDrafts({ accountId }), []);
    assert.ok(f.commands.every(command => ['read', 'navigate'].includes(command.type)));
  } finally { f.close(); }
});

test('remote drafts reject paths, media URLs, API IDs, unknown fields and cross-account reads', async () => {
  const f = fixture(); try {
    for (const extra of [{ paths: ['C:\\private.png'] }, { media: [{ type: 'image', url: 'https://example.com/a.png' }] }, { replyTo: '123' }, { quotePostId: '123' }, { altText: 'alt' }])
      await rejects(f.controller.saveDraft({ accountId, draft: { text: 'hello', ...extra } }), 'INVALID_WORKFLOW');
    for (const text of ['', ' ', 'x'.repeat(501)]) await rejects(f.controller.saveDraft({ accountId, draft: { text } }), 'INVALID_WORKFLOW');
    await assert.rejects(f.controller.saveDraft({ accountId, draft: { text: 'hello', quoteUrl: 'https://example.com/post/a' } }));
    await rejects(f.controller.saveDraft({ accountId, draft: { text: 'hello' }, path: 'C:\\x' }), 'INVALID_WORKFLOW');
    await f.controller.saveDraft({ accountId, draft: { text: 'private to fixture' } });
    f.viewer('another');
    await rejects(f.controller.listDrafts({ accountId }), 'ACCOUNT_MISMATCH');
    await rejects(f.controller.listSchedules({ accountId }), 'ACCOUNT_MISMATCH');
    assert.deepEqual(await f.controller.listDrafts({ accountId: 'another' }), []);
  } finally { f.close(); }
});

test('remote chain uses preceding confirmed URL and stops on uncertain publication', async () => {
  const f = fixture(); try {
    const { job } = await stage(f, ['first', 'second', 'third']); await f.controller.authorizeSchedule({ accountId, id: job.id });
    f.prepareHook(async () => { if (f.preparations.length === 2) f.uncertain(); });
    const result = await f.controller.runSchedules({ accountId });
    assert.equal(result.jobs[0].status, 'uncertain'); assert.equal(result.jobs[0].parts[0].status, 'confirmed'); assert.equal(result.jobs[0].parts[2].status, 'pending');
    assert.equal(f.preparations[1].kind, 'reply'); assert.equal(f.preparations[1].targetUrl, 'https://www.threads.com/@fixture/post/P1');
    assert.equal(f.executions.length, 2); assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    await rejects(f.controller.authorizeSchedule({ accountId, id: job.id }), 'SCHEDULE_STATE');
  } finally { f.close(); }
});

test('remote reconciliation verifies fresh post and never replays confirmed parts', async () => {
  const f = fixture(); try {
    const { job } = await stage(f, ['first', 'second', 'third']); await f.controller.authorizeSchedule({ accountId, id: job.id });
    f.uncertain();
    await f.controller.runSchedules({ accountId });
    const postUrl = 'https://www.threads.com/@fixture/post/FIRST';
    const reconcile = () => f.controller.reconcileSchedule({ accountId, id: job.id, outcome: { status: 'confirmed', postUrl, evidence: ['User inspected resulting text publication.'] } });
    await rejects(reconcile(), 'RECONCILIATION_NOT_OBSERVED');
    f.observed.push({ url: postUrl, author: { username: accountId }, text: 'first' });
    const reconciled = await reconcile(); assert.equal(reconciled.status, 'staged');
    assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    await f.controller.authorizeSchedule({ accountId, id: job.id }); f.uncertain(false);
    const result = await f.controller.runSchedules({ accountId });
    assert.equal(result.jobs[0].status, 'confirmed'); assert.equal(f.executions.length, 3);
    assert.equal(f.preparations[1].text, 'second'); assert.equal(f.preparations[1].targetUrl, postUrl);
  } finally { f.close(); }
});

test('reconciliation cannot upgrade unverified reply relation or media attachment contents', async () => {
  for (const kind of ['reply', 'media']) {
    const f = fixture(true); try {
      const draft = await f.controller.saveDraft({ accountId, draft: { text: 'same text', ...(kind === 'reply' ? { replyUrl: 'https://www.threads.com/@someone/post/SOURCE' } : { mediaToken: 'known-token' }) } });
      const job = await f.controller.stageSchedule({ accountId, draftIds: [draft.id], at });
      await f.controller.authorizeSchedule({ accountId, id: job.id }); f.uncertain(); await f.controller.runSchedules({ accountId });
      const postUrl = 'https://www.threads.com/@fixture/post/RESULT'; f.observed.push({ url: postUrl, author: { username: accountId }, text: 'same text' });
      await rejects(f.controller.reconcileSchedule({ accountId, id: job.id, outcome: { status: 'confirmed', postUrl, evidence: ['Text matches.'] } }), 'RECONCILIATION_DIMENSIONS_UNVERIFIED');
      assert.equal((await f.controller.listSchedules({ accountId }))[0].status, 'uncertain');
      assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    } finally { f.close(); }
  }
});

test('restart and credential invalidation halt previously authorized durable jobs', async () => {
  const f = fixture(); try {
    const first = await stage(f); await f.controller.authorizeSchedule({ accountId, id: first.job.id });
    f.restart(); assert.equal((await f.controller.listSchedules({ accountId }))[0].status, 'cancelled');
    assert.equal((await f.controller.runSchedules({ accountId })).jobs.length, 0);
    const second = await stage(f, ['second']); await f.controller.authorizeSchedule({ accountId, id: second.job.id }); f.controller.invalidate();
    assert.equal((await f.controller.listSchedules({ accountId })).find(job => job.id === second.job.id)?.status, 'cancelled');
    assert.equal(f.executions.length, 0);
  } finally { f.close(); }
});

test('revocation after prepare or during cooldown prevents execute and preserves failure evidence', async () => {
  for (const phase of ['prepare', 'wait']) {
    const f = fixture(); try {
      const { job } = await stage(f); await f.controller.authorizeSchedule({ accountId, id: job.id });
      const revoke = async () => { f.controller.invalidate(); f.deny(); };
      if (phase === 'prepare') f.prepareHook(revoke); else f.waitHook(revoke);
      const result = await f.controller.runSchedules({ accountId });
      assert.equal(result.jobs[0].status, 'failed'); assert.equal(f.executions.length, 0);
      assert.doesNotMatch(JSON.stringify(result), /Private access detail/);
    } finally { f.close(); }
  }
});

test('cancel during first execution stops the next chain part', async () => {
  const f = fixture(); try {
    const { job } = await stage(f, ['first', 'second']); await f.controller.authorizeSchedule({ accountId, id: job.id });
    f.executeHook(async () => { await f.controller.cancelSchedule({ accountId, id: job.id }); });
    const result = await f.controller.runSchedules({ accountId });
    assert.equal(result.jobs[0].status, 'cancelled'); assert.equal(result.jobs[0].parts[0].status, 'confirmed'); assert.equal(f.executions.length, 1);
  } finally { f.close(); }
});

test('busy cancellation is synchronous, exact-job/account bound, authorized and never dispatches browser reads', async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let running: ReturnType<RemoteWorkflowController['runSchedules']> | undefined;
  try {
    const { job } = await stage(f, ['first', 'second']); await f.controller.authorizeSchedule({ accountId, id: job.id });
    assert.throws(() => f.controller.cancelRunning({ accountId, id: job.id }), error => error instanceof ThreadsError && error.code === 'SCHEDULE_NOT_RUNNING');
    f.executeHook(async () => { entered(); await gate; }); running = f.controller.runSchedules({ accountId }); await ready;
    const before = f.commands.length;
    assert.throws(() => f.controller.cancelRunning({ accountId: 'another', id: job.id }), error => error instanceof ThreadsError && error.code === 'SCHEDULE_NOT_RUNNING');
    assert.throws(() => f.controller.cancelRunning({ accountId, id: randomUUID() }), error => error instanceof ThreadsError && error.code === 'SCHEDULE_NOT_RUNNING');
    assert.equal(f.controller.cancelRunning({ accountId, id: job.id }).cancelRequested, true); assert.equal(f.commands.length, before);
    release(); const result = await running; assert.equal(result.jobs[0].status, 'cancelled'); assert.equal(f.executions.length, 1);
    f.deny(); assert.throws(() => f.controller.cancelRunning({ accountId, id: job.id }), error => error instanceof ThreadsError && error.code === 'REMOTE_WRITE_REVOKED');
  } finally { release(); await running; f.close(); }
});

test('run is bounded to three jobs and twenty total parts', async () => {
  const f = fixture(); try {
    for (let index = 0; index < 3; index++) {
      const { job } = await stage(f, Array.from({ length: 8 }, (_, part) => `Job ${index} part ${part}`));
      await f.controller.authorizeSchedule({ accountId, id: job.id });
    }
    await rejects(f.controller.runSchedules({ accountId, limit: 4 }), 'INVALID_WORKFLOW');
    const result = await f.controller.runSchedules({ accountId, limit: 3 });
    assert.equal(result.jobs.length, 2); assert.equal(f.executions.length, 16); assert.equal(result.stopReason, 'part_limit');
  } finally { f.close(); }
});

test('remote media is opt-in and expiry prevents schedule effects after authorization', async () => {
  const disabled = fixture(); try {
    await assert.rejects(disabled.controller.saveDraft({ accountId, draft: { text: 'media', mediaToken: 'known-token' } }));
    assert.equal(disabled.executions.length, 0);
  } finally { disabled.close(); }
  const f = fixture(true); try {
    const draft = await f.controller.saveDraft({ accountId, draft: { text: 'media', mediaToken: 'known-token' } });
    const job = await f.controller.stageSchedule({ accountId, draftIds: [draft.id], at });
    await f.controller.authorizeSchedule({ accountId, id: job.id }); f.mediaExpire();
    const result = await f.controller.runSchedules({ accountId });
    assert.equal(result.jobs[0].status, 'failed'); assert.equal(f.preparations.length, 0); assert.equal(f.executions.length, 0);
  } finally { f.close(); }
});

test('account changes during prepared workflow prevent dispatch; unexpected execution exception becomes uncertain', async () => {
  const f = fixture(); try {
    const { job } = await stage(f); await f.controller.authorizeSchedule({ accountId, id: job.id });
    f.prepareHook(async () => { f.viewer('another'); });
    const result = await f.controller.runSchedules({ accountId }); assert.equal(result.jobs[0].status, 'failed'); assert.equal(f.executions.length, 0);
  } finally { f.close(); }
  const g = fixture(); try {
    const { job } = await stage(g); await g.controller.authorizeSchedule({ accountId, id: job.id });
    g.executeHook(async () => { throw Error('sensitive bridge detail'); });
    const result = await g.controller.runSchedules({ accountId }); assert.equal(result.jobs[0].status, 'uncertain');
    assert.doesNotMatch(JSON.stringify(result), /sensitive bridge detail/); assert.equal((await g.controller.runSchedules({ accountId })).jobs.length, 0);
  } finally { g.close(); }
});
