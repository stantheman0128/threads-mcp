import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserDriver } from '../src/driver.js';
import type { Config } from '../src/config.js';
import type { PageRead } from '../src/page-runtime.js';
import type { SearchIndex } from '../src/search.js';
import type { SocialRequest, SocialStage } from '../src/social-actions.js';
import { ThreadsService } from '../src/service.js';
import { ThreadsError } from '../src/types.js';
import { RemoteSocialController, REMOTE_SOCIAL_KINDS, type RemoteMediaAuthorizer } from '../src/remote-social.js';
import { RemoteSocialDriver } from '../src/remote-social-driver.js';

const target = 'https://www.threads.com/@writer/post/EXACT';
const safeComposer = { present: false, nonempty: false, attachments: false, ambiguous: false };
const args = { kind: 'like', targetUrl: target, expectedAccount: 'fixture' };
class FixtureDriver implements BrowserDriver {
  commands: Record<string, unknown>[] = [];
  url = 'https://www.threads.com/';
  account = 'fixture';
  composer: typeof safeComposer | undefined = { ...safeComposer };
  stageAccount?: string;
  navigateTo?: string;
  switchAccountAtRead = Infinity;
  reads = 0;
  stageGate?: Promise<void>;
  readGate?: Promise<void>;
  stages = 0;
  uncertainCommit = false;
  lastRequest: SocialRequest = args as SocialRequest;
  status() { return { connected: true }; }
  async close() {}
  async command<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(structuredClone(command));
    if (command.type === 'read') {
      await this.readGate;
      if (++this.reads === this.switchAccountAtRead) this.account = 'other';
      return structuredClone({ url: this.url, viewer: { username: this.account }, composerState: this.composer }) as T;
    }
    if (command.type === 'navigate') { this.url = this.navigateTo ?? command.url as string; return { url: this.url } as T; }
    if (command.type !== 'social') throw new Error('Unexpected raw command');
    if (command.operation === 'stage') {
      this.stages++;
      await this.stageGate;
      const request = command.request as SocialRequest;
      this.lastRequest = request;
      return { token: `private-runtime-${this.stages}`, account: this.stageAccount ?? this.account, url: this.url, request,
        noop: false, before: { account: this.account, url: this.url, targetUrl: request.targetUrl, state: 'before', verified: false, evidence: [] } } as T;
    }
    if (command.operation === 'commit') {
      if (this.uncertainCommit) throw new Error('lost reply including private data');
      return { dispatched: true, noop: false } as T;
    }
    const request = command.request as SocialRequest;
    return { account: this.account, url: this.url, targetUrl: request.targetUrl, state: 'after', verified: true, evidence: [] } as T;
  }
}
function fixture(minActionIntervalMs = 0, writesEnabled = true, assertAccess: () => void = () => {}, authorizeMedia?: RemoteMediaAuthorizer) {
  const dataDir = mkdtempSync(join(tmpdir(), 'threads-remote-social-'));
  const raw = new FixtureDriver();
  const readCalls: Record<string, unknown>[] = [];
  const readDriver: BrowserDriver = { status: () => raw.status(), close: async () => {}, command: async <T>(command: Record<string, unknown>) => {
    readCalls.push(command);
    if (!['read','navigate','scroll','open_read_panel','direct_profile'].includes(String(command.type))) throw new ThreadsError('REMOTE_READ_ONLY', 'Only reads.');
    return raw.command<T>(command);
  } };
  const config: Config = { dataDir, profileDir: join(dataDir, 'profile'), channel: 'chrome', headless: true, timeoutMs: 100,
    writesEnabled, minActionIntervalMs };
  const service = new ThreadsService(readDriver, {} as SearchIndex, config);
  const controller = new RemoteSocialController(service, raw, assertAccess, authorizeMedia);
  return { raw, readDriver, readCalls, service, controller, dataDir, cleanup() {
    controller.invalidatePrepared();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + '\\') || resolve(dataDir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dataDir, { recursive: true, force: true });
  } };
}
const operations = (raw: FixtureDriver, name: string) => raw.commands.filter(command => command.operation === name);

function mediaFixture(kind: 'publish' | 'reply' | 'quote' = 'publish') {
  const request = { kind, targetUrl: kind === 'publish' ? 'https://www.threads.com/' : target,
    text: 'Approved fixture media post', mediaToken: 'host-issued-media-token', expectedAccount: 'fixture' };
  const binding = { kind, targetUrl: request.targetUrl, account: 'fixture', active: true };
  let authorizations = 0;
  const h = fixture(0, true, () => {}, (candidate, account) => {
    authorizations++;
    if (!binding.active || candidate.mediaToken !== request.mediaToken || candidate.kind !== binding.kind ||
        candidate.targetUrl !== binding.targetUrl || account !== binding.account)
      throw new ThreadsError('MEDIA_APPROVAL_STALE', 'Media approval is unknown, stale or does not match the account and target.');
  });
  h.raw.url = request.targetUrl;
  h.raw.composer = { ...safeComposer, present: true, attachments: true };
  return { ...h, request, binding, authorizations: () => authorizations };
}

test('media callback is opt-in and restricts mediaToken to strict publication requests', async () => {
  const h = fixture();
  try {
    await assert.rejects(h.controller.prepare({ kind: 'publish', targetUrl: 'https://www.threads.com/', text: 'text',
      mediaToken: 'host-issued-media-token', expectedAccount: 'fixture' }), { code: 'INVALID_INPUT' });
    assert.equal(h.raw.commands.length, 0);
  } finally { h.cleanup(); }
  const m = mediaFixture();
  try {
    for (const request of [{ ...m.request, mediaToken: '' }, { ...m.request, mediaToken: '../token' }, { ...m.request, mediaToken: undefined },
      { ...m.request, mediaToken: 'x'.repeat(101) }, { ...args, mediaToken: m.request.mediaToken }, { ...m.request, files: [] }])
      await assert.rejects(m.controller.prepare(request), { code: 'INVALID_INPUT' });
    assert.equal(m.raw.commands.length, 0); assert.equal(m.authorizations(), 0);
  } finally { m.cleanup(); }
});

test('bound media supports publish, reply and quote on the existing route and remains single-use', async () => {
  for (const kind of ['publish','reply','quote'] as const) {
    const h = mediaFixture(kind);
    try {
      const prepared = await h.controller.prepare(h.request);
      assert.equal(prepared.request.mediaToken, h.request.mediaToken);
      assert.equal(h.authorizations(), 3); // target, immediately before stage, after stage
      assert.equal((await h.controller.execute(prepared.id, 'fixture')).outcome, 'verified'); // synthetic runtime observation only
      assert.equal(h.authorizations(), 4); // immediately before commit
      await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
      assert.equal(operations(h.raw, 'commit').length, 1);
      assert.equal(h.readCalls.length, 0);
      assert.ok(!h.raw.commands.some(command => command.type === 'navigate'));
    } finally { h.cleanup(); }
  }
});

test('unknown, stale and mismatched media bindings fail before stage without navigation', async () => {
  for (const failure of ['unknown','stale','bound-target','bound-account','current-target','viewer']) {
    const h = mediaFixture();
    try {
      let request = h.request;
      if (failure === 'unknown') request = { ...request, mediaToken: 'unissued-token' };
      if (failure === 'stale') h.binding.active = false;
      if (failure === 'bound-target') h.binding.targetUrl = target;
      if (failure === 'bound-account') h.binding.account = 'other';
      if (failure === 'current-target') h.raw.url = target;
      if (failure === 'viewer') h.raw.account = 'other';
      await assert.rejects(h.controller.prepare(request), { code: failure === 'current-target' ? 'TARGET_CHANGED_ROUTE' : failure === 'viewer' ? 'ACCOUNT_MISMATCH' : 'MEDIA_APPROVAL_STALE' });
      assert.equal(operations(h.raw, 'stage').length, 0); assert.equal(h.readCalls.length, 0);
    } finally { h.cleanup(); }
  }
});

test('approved media still rejects unrelated text drafts, ambiguous or missing composers', async () => {
  for (const state of [undefined, { ...safeComposer, present: true, attachments: true, nonempty: true },
    { ...safeComposer, present: true, attachments: true, ambiguous: true }, { ...safeComposer }]) {
    const h = mediaFixture();
    try {
      h.raw.composer = state;
      await assert.rejects(h.controller.prepare(h.request), { code: 'COMPOSER_BUSY' });
      assert.equal(operations(h.raw, 'stage').length, 0); assert.equal(h.readCalls.length, 0);
    } finally { h.cleanup(); }
  }
});

test('media revoked during an awaited precommit read blocks dispatch and consumes the preparation', async () => {
  const h = mediaFixture();
  try {
    const prepared = await h.controller.prepare(h.request);
    let release!: () => void;
    h.raw.readGate = new Promise<void>(resolve => { release = resolve; });
    const pending = h.controller.execute(prepared.id, 'fixture');
    await new Promise(resolve => setImmediate(resolve));
    h.binding.active = false; release();
    const result = await pending;
    assert.equal(result.outcome, 'outcome-uncertain');
    assert.equal('error' in result ? result.error : undefined, 'MEDIA_APPROVAL_STALE');
    assert.equal(operations(h.raw, 'commit').length, 0);
    h.binding.active = true; h.raw.readGate = undefined;
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
  } finally { h.cleanup(); }
});

test('media revoked during staging cannot yield a preparation, and moved media never commits', async () => {
  const h = mediaFixture();
  try {
    let release!: () => void;
    h.raw.stageGate = new Promise<void>(resolve => { release = resolve; });
    const pending = h.controller.prepare(h.request);
    const rejected = assert.rejects(pending, { code: 'MEDIA_APPROVAL_STALE' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(operations(h.raw, 'stage').length, 1);
    h.binding.active = false; release(); await rejected;
    h.binding.active = true; h.raw.stageGate = undefined;
    const prepared = await h.controller.prepare(h.request);
    h.raw.url = target;
    const result = await h.controller.execute(prepared.id, 'fixture');
    assert.equal(result.outcome, 'outcome-uncertain');
    assert.equal('error' in result ? result.error : undefined, 'TARGET_CHANGED_ROUTE');
    assert.equal(operations(h.raw, 'commit').length, 0); assert.equal(h.readCalls.length, 0);
  } finally { h.cleanup(); }
});

test('shared controller retains preparation across two requests, executes once and writes only bounded audit fields', async () => {
  const h = fixture();
  try {
    const requestOne = () => h.controller.prepare(args);
    const prepared = await requestOne();
    assert.equal(prepared.account, 'fixture'); assert.equal(prepared.published, false);
    assert.ok(!JSON.stringify(prepared).includes('private-runtime'));
    const requestTwo = () => h.controller.execute(prepared.id, '@fixture');
    assert.equal((await requestTwo()).outcome, 'verified');
    await assert.rejects(requestTwo(), { code: 'INVALID_ACTION' });
    assert.equal(operations(h.raw, 'commit').length, 1);
    assert.deepEqual(h.readCalls.map(command => command.type), ['navigate']);
    const audit = readFileSync(join(h.dataDir, 'remote-actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(audit.map(event => event.outcome), ['commit-started','verified']);
    for (const event of audit) assert.deepEqual(Object.keys(event).sort(), ['id','kind','outcome','targetUrl']);
  } finally { h.cleanup(); }
});

test('wrong account is rejected before navigation and before final staging after an account switch', async () => {
  for (const switchAt of [1, 3]) {
    const h = fixture();
    try {
      h.raw.switchAccountAtRead = switchAt;
      await assert.rejects(h.controller.prepare(args), { code: 'ACCOUNT_MISMATCH' });
      assert.equal(operations(h.raw, 'stage').length, 0);
      assert.equal(h.readCalls.length, switchAt === 1 ? 0 : 1);
    } finally { h.cleanup(); }
  }
});

test('missing or busy composer state blocks inspect and prepare without navigating or staging', async () => {
  const states = [undefined, ...Object.keys(safeComposer).map(key => ({ ...safeComposer, [key]: true }))];
  for (const state of states) for (const operation of ['inspect','prepare'] as const) {
    const h = fixture();
    try {
      h.raw.composer = state;
      await assert.rejects(h.controller[operation](args), { code: 'COMPOSER_BUSY' });
      assert.equal(h.raw.commands.length, 1);
      assert.equal(h.readCalls.length, 0);
    } finally { h.cleanup(); }
  }
});

test('checked routes bind publishing to home, follows to profile and other actions to exact post', async () => {
  for (const request of [
    { kind: 'publish', targetUrl: 'https://threads.net/', text: 'approved text' },
    { kind: 'follow', targetUrl: 'https://threads.com/@writer/' },
    { kind: 'reply', targetUrl: target, text: 'approved reply' },
  ]) {
    const h = fixture();
    try {
      h.raw.url = 'https://www.threads.com/@elsewhere';
      const prepared = await h.controller.prepare({ ...request, expectedAccount: 'fixture' });
      const expected = new URL(request.targetUrl); expected.hostname = 'www.threads.com'; expected.pathname = expected.pathname.replace(/\/$/, '') || '/';
      assert.equal(prepared.request.targetUrl, expected.href);
      assert.deepEqual(h.readCalls, [{ type: 'navigate', url: expected.href }]);
      assert.equal(operations(h.raw, 'stage').length, 1);
    } finally { h.cleanup(); }
  }
});

test('malformed targets, unknown fields, delete and media never reach browser commands', async () => {
  assert.equal(REMOTE_SOCIAL_KINDS.length, 11);
  const invalid = [{ ...args, expectedAccount: undefined }, { ...args, expectedAccount: '' }, { ...args, kind: 'delete' },
    { ...args, mediaToken: 'private' }, { ...args, extra: true }, { ...args, targetUrl: 'https://www.threads.com/direct/inbox' },
    { ...args, targetUrl: `${target}?secret=value` }, { ...args, targetUrl: 'https://www.threads.com/post/EXACT' },
    { ...args, kind: 'follow' }, { ...args, kind: 'publish', targetUrl: 'https://www.threads.com/' },
    { ...args, kind: 'quote', text: 'x'.repeat(501) }, { ...args, kind: 'reply', text: ' ' }, { ...args, text: 'unneeded' }];
  const h = fixture();
  try {
    for (const request of invalid) await assert.rejects(h.controller.prepare(request), { code: 'INVALID_INPUT' });
    assert.equal(h.raw.commands.length, 0);
    await assert.rejects(h.controller.inspect({ kind: 'like', targetUrl: target }), { code: 'INVALID_INPUT' });
    assert.equal(h.raw.commands.length, 0);
  } finally { h.cleanup(); }
});

test('read-only config blocks preparation before navigating and permits guarded inspection', async () => {
  const h = fixture(0, false);
  try {
    await assert.rejects(h.controller.prepare(args), { code: 'WRITES_DISABLED' });
    assert.equal(h.raw.commands.length, 0);
    assert.equal((await h.controller.inspect(args)).account, 'fixture');
    assert.equal(operations(h.raw, 'stage').length, 0);
  } finally { h.cleanup(); }
});

test('failed navigation binding or returned stage account mismatch never yields an executable preparation', async () => {
  for (const failure of ['route','account']) {
    const h = fixture();
    try {
      const prior = failure === 'account' ? await h.controller.prepare(args) : undefined;
      if (failure === 'route') h.raw.navigateTo = 'https://www.threads.com/@other'; else h.raw.stageAccount = 'other';
      await assert.rejects(h.controller.prepare(args), { code: failure === 'route' ? 'TARGET_CHANGED_ROUTE' : 'ACCOUNT_MISMATCH' });
      if (prior) await assert.rejects(h.controller.execute(prior.id, 'fixture'), { code: 'INVALID_ACTION' });
      assert.equal(operations(h.raw, 'commit').length, 0);
    } finally { h.cleanup(); }
  }
});

test('expiration, wrong execution account and shared cooldown consume ids without commit replay', async t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  const h = fixture(10_000);
  try {
    let prepared = await h.controller.prepare(args);
    now += 90_001;
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'EXPIRED_ACTION' });
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
    prepared = await h.controller.prepare(args);
    await assert.rejects(h.controller.execute(prepared.id, 'other'), { code: 'ACCOUNT_MISMATCH' });
    prepared = await h.controller.prepare(args); assert.equal((await h.controller.execute(prepared.id, 'fixture')).verified, true);
    prepared = await h.controller.prepare(args);
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'ACTION_COOLDOWN' });
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
    assert.equal(operations(h.raw, 'commit').length, 1);
  } finally { h.cleanup(); }
});

test('bearer invalidation clears issued ids and cannot resurrect a preparation finishing asynchronously', async () => {
  const h = fixture();
  try {
    let prepared = await h.controller.prepare(args); h.controller.invalidatePrepared();
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
    let release!: () => void;
    h.raw.stageGate = new Promise<void>(resolve => { release = resolve; });
    const pending = h.controller.prepare(args);
    const rejected = assert.rejects(pending, { code: 'ACTION_CANCELLED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.raw.stages, 2);
    h.controller.invalidatePrepared(); release(); await rejected;
    h.raw.stageGate = undefined;
    prepared = await h.controller.prepare(args);
    assert.equal((await h.controller.execute(prepared.id, 'fixture')).verified, true);
    assert.equal(operations(h.raw, 'commit').length, 1);
  } finally { h.cleanup(); }
});

test('access callback detects revocation during a pending precommit read without another HTTP request', async () => {
  let allowed = true;
  const h = fixture(0, true, () => { if (!allowed) { h.controller.invalidatePrepared(); throw new ThreadsError('ACCESS_CHANGED', 'Access changed.'); } });
  try {
    const prepared = await h.controller.prepare(args);
    let release!: () => void;
    h.raw.readGate = new Promise<void>(resolve => { release = resolve; });
    const pending = h.controller.execute(prepared.id, 'fixture');
    await new Promise(resolve => setImmediate(resolve));
    allowed = false; release();
    const result = await pending;
    assert.equal(result.outcome, 'outcome-uncertain');
    assert.equal('error' in result ? result.error : undefined, 'ACCESS_CHANGED');
    assert.equal(operations(h.raw, 'commit').length, 0);
    allowed = true; h.raw.readGate = undefined;
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
  } finally { h.cleanup(); }
});

test('access callback rejects a stage completing after revocation without returning an id', async () => {
  let allowed = true;
  const h = fixture(0, true, () => { if (!allowed) { h.controller.invalidatePrepared(); throw new ThreadsError('ACCESS_CHANGED', 'Access changed.'); } });
  try {
    let release!: () => void;
    h.raw.stageGate = new Promise<void>(resolve => { release = resolve; });
    const pending = h.controller.prepare(args);
    const rejected = assert.rejects(pending, { code: 'ACCESS_CHANGED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.raw.stages, 1);
    allowed = false; release(); await rejected;
    assert.equal(operations(h.raw, 'commit').length, 0);
    allowed = true; h.raw.stageGate = undefined;
    const prepared = await h.controller.prepare(args);
    assert.equal((await h.controller.execute(prepared.id, 'fixture')).verified, true);
  } finally { h.cleanup(); }
});

test('uncertain dispatch is consumed once and returns no raw exception or private token', async () => {
  const h = fixture();
  try {
    h.raw.uncertainCommit = true;
    const prepared = await h.controller.prepare(args);
    const result = await h.controller.execute(prepared.id, 'fixture');
    assert.equal(result.outcome, 'outcome-uncertain');
    assert.ok(!JSON.stringify(result).includes('private'));
    await assert.rejects(h.controller.execute(prepared.id, 'fixture'), { code: 'INVALID_ACTION' });
    assert.equal(operations(h.raw, 'commit').length, 1);
  } finally { h.cleanup(); }
});

test('social driver delegates read guards and refuses arbitrary commands, unbound commits and changed routes', async () => {
  const h = fixture();
  try {
    const driver = new RemoteSocialDriver(h.raw, h.readDriver);
    for (const command of [{ type: 'media', operation: 'begin' }, { type: 'interact', ref: 'x' }, { type: 'evaluate', script: 'x' }])
      await assert.rejects(driver.command(command), { code: 'REMOTE_READ_ONLY' });
    await assert.rejects(driver.command({ type: 'social', operation: 'commit', token: 'invented', expectedAccount: 'fixture' }), { code: 'INVALID_ACTION' });
    driver.expectAccount('fixture');
    await assert.rejects(driver.command({ type: 'social', operation: 'stage', request: { kind: 'like', targetUrl: target } }), { code: 'TARGET_CHANGED_ROUTE' });
    h.raw.url = target;
    const staged = await driver.command<SocialStage>({ type: 'social', operation: 'stage', request: { kind: 'like', targetUrl: target } });
    h.raw.url = 'https://www.threads.com/@writer/post/OTHER';
    await assert.rejects(driver.command({ type: 'social', operation: 'commit', token: staged.token, expectedAccount: 'fixture' }), { code: 'TARGET_CHANGED_ROUTE' });
    h.raw.url = target;
    await assert.rejects(driver.command({ type: 'social', operation: 'commit', token: staged.token, expectedAccount: 'fixture' }), { code: 'INVALID_ACTION' });
    assert.equal(operations(h.raw, 'commit').length, 0);
  } finally { h.cleanup(); }
});
