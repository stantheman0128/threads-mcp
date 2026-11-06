import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { validateRemoteBrowserCommand } from '../src/remote-browser-runtime.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return { addListener(fn: (...args: any[]) => void) { listeners.add(fn); }, removeListener(fn: (...args: any[]) => void) { listeners.delete(fn); },
    emit(...args: any[]) { for (const fn of listeners) fn(...args); } };
}
function harness(injectedVersion = '0.1.1') {
  const tab = { id: 42, windowId: 7, active: false, status: 'complete', url: 'https://www.threads.com/@old', title: 'Fixture' };
  const page = { url: tab.url, documentId: 'document-0', readyState: 'complete', text: 'Fixture content', rawText: 'Fixture content' };
  const calls: { kind: string; args?: any }[] = [];
  const onUpdated = event();
  let focused = false;
  let runtimeVersion = '0.1.1';
  let runtimeProbeGate: Promise<void> | undefined;
  let navigationProbeGate: Promise<void> | undefined;
  let baselineProbeGate: Promise<void> | undefined;
  let updateGate: Promise<void> | undefined;
  let navigationProbeFails = false;
  const navigationDeadlines: Array<() => void> = [];
  let commitDocumentOnUpdate = true;
  let documentNumber = 0;
  let holdDirectProfile = false;
  let rejectDirectProfile: ((error: Error) => void) | undefined;
  let holdRemoteBrowser = false;
  let rejectRemoteBrowser: ((error: Error) => void) | undefined;
  const chrome = {
    runtime: { id: 'fixture', getManifest: () => ({ version: '0.1.1' }), onMessage: event() }, storage: { session: { set: async () => undefined } },
    tabs: { onUpdated, onRemoved: event(), get: async (id: number) => { calls.push({ kind: 'get', args: id }); return { ...tab }; },
      update: async (id: number, options: any) => { calls.push({ kind: 'update', args: { id, ...options } }); await updateGate; if (commitDocumentOnUpdate) page.documentId = `document-${++documentNumber}`; return { ...tab }; },
      query: async () => [{ ...tab }], captureVisibleTab: async () => { calls.push({ kind: 'capture' }); return 'data:image/jpeg;base64,fixture'; } },
    windows: { get: async () => ({ focused }), update: async () => { calls.push({ kind: 'focus' }); throw new Error('Unexpected focus'); } },
    scripting: { executeScript: async (options: any) => {
      calls.push({ kind: 'script', args: { tabId: options.target.tabId, documentIds: options.target.documentIds, files: options.files, injectImmediately: options.injectImmediately } });
      if (options.target.documentIds && !options.target.documentIds.includes(page.documentId)) throw new Error('No matching document');
      const documentId = page.documentId;
      if (options.files) { runtimeVersion = injectedVersion; return [{ documentId, frameId: 0, result: undefined }]; }
      if (options.args?.length === 1 && typeof options.args[0] === 'string') await runtimeProbeGate;
      if (options.func.toString().includes('readyState')) { if (navigationProbeFails) throw new Error('Synthetic probe failure'); await navigationProbeGate; }
      else if (options.func.toString().includes('location.href')) await baselineProbeGate;
      const runtime = { runtimeVersion, readPage: () => { calls.push({ kind: 'read' }); return { posts: ['fixture'] }; }, snapshot: () => ({ snapshotId: 's' }),
        scroll: (pixels: number) => { calls.push({ kind: 'scroll', args: pixels }); return { scrolled: pixels }; },
        openReadPanel: (panel: string,activityTab?:string) => { calls.push({ kind: 'panel', args: {panel,activityTab} }); return { panel,activityTab }; },
        interact: () => { calls.push({ kind: 'interact' }); return { done: true }; },
        socialCommit: () => { calls.push({ kind: 'social-commit' }); return { dispatched: true }; },
        socialPrepareConfirmation: (sourceToken: string, expectedAccount: string) => { calls.push({ kind: 'social-prepare-confirmation', args: { sourceToken, expectedAccount } }); return { token: 'final-token', published: false }; },
        socialCommitConfirmation: (token: string, expectedAccount: string) => { calls.push({ kind: 'social-commit-confirmation', args: { token, expectedAccount } }); return { dispatched: true, verified: false }; },
        validateRemoteBrowserCommand,
        remoteView: (command: unknown) => { calls.push({ kind: 'remote-view', args: command }); return { dispatched: true, verified: false }; },
        remoteBrowser: (command: unknown) => {
          calls.push({ kind: 'remote-browser', args: command });
          if (holdRemoteBrowser) return new Promise((_resolve, reject) => { rejectRemoteBrowser = reject; });
          return { scope: 'public-read-navigation' };
        },
        directProfile: (args: unknown) => {
          calls.push({ kind: 'direct-profile', args });
          if (holdDirectProfile) return new Promise((_resolve, reject) => { rejectDirectProfile = reject; });
          return { posts: [], partial: true };
        },
        cancelDirectProfiles: () => { calls.push({ kind: 'cancel-direct' }); rejectDirectProfile?.(new Error('DIRECT_PROFILE_CANCELLED: Cancelled.')); },
        cancelMediaTransfers: () => { calls.push({ kind: 'cancel-media' }); },
        cancelRemoteBrowserActions: () => { calls.push({ kind: 'cancel-remote-browser' }); rejectRemoteBrowser?.(new Error('REMOTE_BROWSER_CANCELLED: Cancelled.')); },
        cancelRemoteViews: () => { calls.push({ kind: 'cancel-remote-views' }); },
        cancelSocialActions: () => { calls.push({ kind: 'cancel-social' }); } };
      const result = await runInNewContext(`(${options.func.toString()})(...args)`, { args: options.args ?? [], ThreadsMCP: runtime,
        location: { href: page.url }, document: { readyState: page.readyState, body: { textContent: page.rawText, innerText: page.text } } });
      return [{ documentId, frameId: 0, result }];
    } },
  };
  const context = createContext({ chrome, URL, setTimeout: (fn: () => void, ms: number) => {
    if (ms === 20000) navigationDeadlines.push(fn);
    return setTimeout(fn, ms);
  }, clearTimeout, setInterval, clearInterval, TextEncoder,
    WebSocket: { OPEN: 1 }, console });
  runInContext(source, context);
  runInContext('boundTabId = 42; connected = true; globalThis.testing = { execute: command => execute(command, epoch), disconnect, navigationCount: () => pendingNavigations.size };', context);
  const api = (context as any).testing as { execute(command: object): Promise<any>; disconnect(): void; navigationCount(): number };
  return { api, tab, page, calls, onUpdated, focus: (value: boolean) => { focused = value; },
    holdDirectProfile: () => { holdDirectProfile = true; },
    holdRemoteBrowser: () => { holdRemoteBrowser = true; },
    runtimeVersion: (value: string) => { runtimeVersion = value; },
    holdRuntimeProbe: (gate: Promise<void>) => { runtimeProbeGate = gate; },
    holdNavigationProbe: (gate: Promise<void>) => { navigationProbeGate = gate; },
    holdBaselineProbe: (gate: Promise<void>) => { baselineProbeGate = gate; },
    holdUpdate: (gate: Promise<void>) => { updateGate = gate; },
    failNavigationProbe: () => { navigationProbeFails = true; },
    expireNavigation: () => { navigationDeadlines.at(-1)!(); },
    commitOnUpdate: (value: boolean) => { commitDocumentOnUpdate = value; },
    status: () => { let status: any; chrome.runtime.onMessage.emit({ type: 'status' }, { id: 'fixture' }, (value: any) => { status = value; }); return status; },
    cleanup: () => api.disconnect() };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('direct profile dispatch is typed, document pinned and allowed in the hidden selected tab', async () => {
  const h = harness();
  const command = { type: 'direct_profile', username: 'fixture.name', maxPages: 2, pageSize: 10 };
  try {
    assert.equal((await h.api.execute(command)).partial, true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call.kind === 'direct-profile')?.args)),
      { username: 'fixture.name', maxPages: 2, pageSize: 10 });
    const scripts = h.calls.filter(call => call.kind === 'script');
    assert.deepEqual([...scripts.at(-1)!.args.documentIds], ['document-0']);
    for (const invalid of [{ ...command, url: 'https://www.threads.com/' }, { ...command, cursor: 'opaque' },
      { ...command, username: '@fixture' }, { ...command, maxPages: 6 }, { ...command, pageSize: 21 }, { ...command, pageSize: '10' }])
      await assert.rejects(h.api.execute(invalid), { code: 'INVALID_COMMAND' });
    assert.equal(h.calls.filter(call => call.kind === 'direct-profile').length, 1);
    assert.ok(!h.calls.some(call => call.kind === 'focus' || call.kind === 'update'));
  } finally { h.cleanup(); }
});

test('disconnect cancels an in-flight direct profile and keeps media and social cancellation', async () => {
  const h = harness();
  h.holdDirectProfile();
  const pending = h.api.execute({ type: 'direct_profile', username: 'fixture', maxPages: 1, pageSize: 1 });
  const rejected = assert.rejects(pending, { code: 'BRIDGE_DISCONNECTED' });
  await delay(0);
  assert.equal(h.calls.filter(call => call.kind === 'direct-profile').length, 1);
  h.api.disconnect();
  await rejected;
  for (const kind of ['cancel-direct', 'cancel-media', 'cancel-social', 'cancel-remote-browser', 'cancel-remote-views']) assert.equal(h.calls.filter(call => call.kind === kind).length, 1);
});

test('remote browser/view and final confirmations dispatch once on the pinned hidden document', async () => {
  const h = harness();
  const token = '12345678-1234-4123-8123-123456789012';
  const commands = [
    { type: 'remote_view', kind: 'notifications', expectedAccount: 'fixture', navigationToken: token },
    { type: 'remote_browser', operation: 'snapshot', expectedAccount: 'fixture' },
    { type: 'social', operation: 'prepare_confirmation', sourceToken: token, expectedAccount: 'fixture' },
    { type: 'social', operation: 'commit_confirmation', token, expectedAccount: 'fixture' },
  ];
  try {
    for (const command of commands) {
      await h.api.execute(command);
      const scripts = h.calls.filter(call => call.kind === 'script');
      assert.deepEqual([...scripts.at(-1)!.args.documentIds], ['document-0']);
    }
    for (const kind of ['remote-view', 'remote-browser', 'social-prepare-confirmation', 'social-commit-confirmation'])
      assert.equal(h.calls.filter(call => call.kind === kind).length, 1);
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(h.calls.find(call => call.kind === 'remote-view')!.args), commands[0]);
    assert.deepEqual(plain(h.calls.find(call => call.kind === 'remote-browser')!.args), commands[1]);
    assert.deepEqual(plain(h.calls.find(call => call.kind === 'social-prepare-confirmation')!.args), { sourceToken: token, expectedAccount: 'fixture' });
    assert.deepEqual(plain(h.calls.find(call => call.kind === 'social-commit-confirmation')!.args), { token, expectedAccount: 'fixture' });
    await assert.rejects(h.api.execute({ ...commands[1], code: 'arbitrary' }), { code: 'INVALID_COMMAND' });
    assert.equal(h.calls.filter(call => call.kind === 'remote-browser').length, 1);
    assert.ok(!h.calls.some(call => ['focus', 'update', 'interact', 'social-commit'].includes(call.kind)));
  } finally { h.cleanup(); }
});

test('remote browser/view cannot dispatch into a replacement document or after disconnect during probe', async () => {
  for (const type of ['remote_browser', 'remote_view']) for (const disconnect of [false, true]) {
    const h = harness(); let release!: () => void;
    h.holdRuntimeProbe(new Promise<void>(resolve => { release = resolve; }));
    const command = type === 'remote_browser' ? { type, operation: 'snapshot', expectedAccount: 'fixture' } :
      { type, kind: 'following', expectedAccount: 'fixture', navigationToken: '12345678-1234-4123-8123-123456789012' };
    try {
      const pending = h.api.execute(command);
      const rejected = disconnect ? assert.rejects(pending, { code: 'BRIDGE_DISCONNECTED' }) : assert.rejects(pending, /No matching document/);
      await delay(0);
      if (disconnect) h.api.disconnect(); else h.page.documentId = 'replacement';
      release(); await rejected;
      assert.equal(h.calls.filter(call => call.kind === 'remote-browser' || call.kind === 'remote-view').length, 0);
    } finally { release(); h.cleanup(); }
  }
});

test('disconnect cancels in-flight remote browser runtime and both remote state bindings', async () => {
  const h = harness(); h.holdRemoteBrowser();
  const pending = h.api.execute({ type: 'remote_browser', operation: 'snapshot', expectedAccount: 'fixture' });
  const rejected = assert.rejects(pending, { code: 'REMOTE_BROWSER_CANCELLED' });
  await delay(0); h.api.disconnect(); await rejected;
  assert.equal(h.calls.filter(call => call.kind === 'remote-browser').length, 1);
  assert.equal(h.calls.filter(call => call.kind === 'cancel-remote-browser').length, 1);
  assert.equal(h.calls.filter(call => call.kind === 'cancel-remote-views').length, 1);
});

function connectionHarness() {
  const storage: Array<() => void> = [];
  const timeouts: Array<{ fn: () => void; ms: number; cleared?: boolean }> = [];
  const intervals: Array<{ fn: () => void; ms: number; cleared?: boolean }> = [];
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    closed = false;
    sent: string[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onopen?: () => void;
    onerror?: () => void;
    constructor(_url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; }
    ready() { this.onmessage?.({ data: '{"type":"ready"}' }); }
  }
  const messages = event();
  const chrome = { runtime: { id: 'fixture', getManifest: () => ({ version: '0.1.1' }), onMessage: messages },
    tabs: { query: async () => [{ id: 42, url: 'https://www.threads.com/@fixture' }], onUpdated: event(), onRemoved: event() },
    storage: { session: { set: () => new Promise<void>(resolve => storage.push(resolve)) } } };
  const context = createContext({ chrome, URL, WebSocket: FakeSocket, TextEncoder,
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, ms }; timeouts.push(timer); return timer; },
    clearTimeout: (timer: { cleared?: boolean }) => { if (timer) timer.cleared = true; },
    setInterval: (fn: () => void, ms: number) => { const timer = { fn, ms }; intervals.push(timer); return timer; },
    clearInterval: (timer: { cleared?: boolean }) => { if (timer) timer.cleared = true; } });
  runInContext(source, context);
  runInContext('globalThis.testing={connect,disconnect,state:()=>({connected,epoch})};', context);
  const api = (context as any).testing as { connect(port: number, token: string): Promise<any>; disconnect(): void; state(): { connected: boolean; epoch: number } };
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  return { api, sockets, storage, timeouts, intervals, drain,
    popupConnect: () => messages.emit({ type: 'connect', port: 19758, token: 'a'.repeat(64) }, { id: 'fixture' }, () => { throw new Error('Popup response channel closed'); }) };
}

test('superseded storage completion cannot create a socket or disconnect a successful newer attempt', async () => {
  const h = connectionHarness();
  const first = h.api.connect(19758, 'a'.repeat(64)).catch(error => error.code);
  await h.drain();
  const second = h.api.connect(19758, 'a'.repeat(64));
  await h.drain();
  h.storage[1](); await h.drain();
  h.sockets[0].ready(); await second;
  h.storage[0]();
  assert.equal(await first, 'CONNECTION_CANCELLED');
  assert.equal(h.sockets.length, 1);
  assert.equal(h.api.state().connected, true);
  assert.equal(h.sockets[0].closed, false);
  h.api.disconnect();
});

test('stale socket callbacks and cancelled handshake timeout cannot close a newer connection', async () => {
  const h = connectionHarness();
  const first = h.api.connect(19758, 'a'.repeat(64)).catch(error => error.code);
  await h.drain(); h.storage[0](); await h.drain();
  const oldSocket = h.sockets[0];
  const oldTimeout = h.timeouts[0];
  const second = h.api.connect(19758, 'a'.repeat(64));
  await h.drain(); h.storage[1](); await h.drain();
  h.sockets[1].ready(); await second;
  assert.equal(await first, 'CONNECTION_CANCELLED');
  oldSocket.onclose?.(); oldSocket.onerror?.(); oldSocket.onopen?.(); oldTimeout.fn();
  // Even a timeout callback already queued when ready arrived must be harmless.
  h.timeouts[1].fn();
  assert.equal(h.api.state().connected, true);
  assert.equal(h.sockets[1].closed, false);
  assert.equal(oldSocket.sent.length, 0);
  h.api.disconnect();
});

test('explicit disconnect during storage wait prevents later connection resurrection', async () => {
  const h = connectionHarness();
  const pending = h.api.connect(19758, 'a'.repeat(64)).catch(error => error.code);
  await h.drain(); h.api.disconnect(); h.storage[0]();
  assert.equal(await pending, 'CONNECTION_CANCELLED');
  assert.equal(h.sockets.length, 0);
  assert.equal(h.api.state().connected, false);
});

test('closed popup response channel does not close worker connection or stop its heartbeat', async () => {
  const h = connectionHarness();
  h.popupConnect(); await h.drain(); h.storage[0](); await h.drain();
  h.sockets[0].ready(); await h.drain();
  assert.equal(h.api.state().connected, true);
  h.intervals[0].fn();
  assert.equal(h.sockets[0].sent.at(-1), '{"type":"ping"}');
  assert.equal(h.sockets[0].closed, false);
  // Duplicate ready responses must not create multiple heartbeat loops.
  h.sockets[0].ready(); assert.equal(h.intervals.length, 1);
  h.api.disconnect();
});

test('inactive selected tab supports reads, snapshots, scrolling and read panels without activation', async () => {
  const h = harness();
  try {
    assert.equal((await h.api.execute({ type: 'read' })).posts[0], 'fixture');
    assert.equal((await h.api.execute({ type: 'snapshot' })).snapshotId, 's');
    assert.equal((await h.api.execute({ type: 'scroll', pixels: 500 })).scrolled, 500);
    for (const panel of ['followers', 'following', 'likers']) assert.equal((await h.api.execute({ type: 'open_read_panel', panel })).panel, panel);
    assert.equal((await h.api.execute({type:'open_read_panel',panel:'likers',activityTab:'reposts'})).activityTab,'reposts');
    await assert.rejects(h.api.execute({type:'open_read_panel',panel:'followers',activityTab:'reposts'}),{code:'INVALID_COMMAND'});
    await assert.rejects(h.api.execute({type:'open_read_panel',panel:'likers',activityTab:'delete'}),{code:'INVALID_COMMAND'});
    assert.equal(h.tab.active, false);
    assert.ok(h.calls.every(call => call.kind !== 'focus' && call.kind !== 'update'));
    assert.ok(h.calls.filter(call => call.kind === 'script').every(call => call.args.tabId === 42));
  } finally { h.cleanup(); }
});

test('writes and screenshots retain active-tab and screenshot focus guards', async () => {
  const h = harness();
  try {
    await assert.rejects(h.api.execute({ type: 'interact', snapshotId: 's', ref: 'r', verb: 'click' }), { code: 'TAB_NOT_ACTIVE' });
    await assert.rejects(h.api.execute({ type: 'screenshot' }), { code: 'TAB_NOT_ACTIVE' });
    h.tab.active = true;
    await assert.rejects(h.api.execute({ type: 'screenshot' }), { code: 'TAB_NOT_VISIBLE' });
    assert.ok(!h.calls.some(call => call.kind === 'capture' || call.kind === 'interact' || call.kind === 'focus'));
    h.focus(true);
    assert.ok((await h.api.execute({ type: 'screenshot' })).dataUrl.startsWith('data:image/jpeg'));
  } finally { h.cleanup(); }
});

test('disconnect during runtime readiness prevents a later prepared commit and invalidates page approvals', async () => {
  const h = harness();
  let release!: () => void;
  h.holdRuntimeProbe(new Promise<void>(resolve => { release = resolve; }));
  const pending = h.api.execute({ type: 'social', operation: 'commit', token: 'fixture', expectedAccount: 'fixture' });
  const rejected = assert.rejects(pending, { code: 'BRIDGE_DISCONNECTED' });
  await delay(0);
  assert.ok(h.calls.some(call => call.kind === 'script'));
  h.api.disconnect();
  release();
  await rejected;
  assert.equal(h.calls.filter(call => call.kind === 'social-commit').length, 0);
  assert.equal(h.calls.filter(call => call.kind === 'cancel-media').length, 1);
  assert.equal(h.calls.filter(call => call.kind === 'cancel-social').length, 1);
});

test('status reports installed version and runtime injection replaces only mismatching versions', async () => {
  const h = harness();
  try {
    assert.equal(h.status().version, '0.1.1');
    assert.equal((await h.api.execute({ type: 'read' })).extensionVersion, '0.1.1');
    assert.equal(h.calls.filter(call => call.kind === 'script' && call.args.files).length, 0);
    h.runtimeVersion('0.1.0');
    await h.api.execute({ type: 'read' });
    assert.equal(h.calls.filter(call => call.kind === 'script' && call.args.files).length, 1);
    await h.api.execute({ type: 'snapshot' });
    assert.equal(h.calls.filter(call => call.kind === 'script' && call.args.files).length, 1);
  } finally { h.cleanup(); }
});

test('runtime setup, invocation and disconnect cancellation bypass document_idle waiting', async () => {
  const h = harness();
  h.runtimeVersion('older-runtime');
  await h.api.execute({ type: 'read' });
  h.api.disconnect();
  const scripts = h.calls.filter(call => call.kind === 'script');
  assert.equal(scripts.length, 4); // version probe, file injection, read invocation, cancellation
  assert.ok(scripts.every(call => call.args.injectImmediately === true));
  assert.deepEqual([...scripts[1].args.documentIds], ['document-0']);
  assert.deepEqual([...scripts[2].args.documentIds], ['document-0']);
});

test('runtime invocation stays pinned to its probed document when navigation replaces it', async () => {
  const h = harness();
  let release!: () => void;
  h.holdRuntimeProbe(new Promise<void>(resolve => { release = resolve; }));
  const pending = h.api.execute({ type: 'read' });
  const rejected = assert.rejects(pending, /No matching document/);
  await delay(0);
  h.page.documentId = 'replacement-document';
  release();
  await rejected;
  assert.equal(h.calls.filter(call => call.kind === 'read').length, 0);
  h.cleanup();
});

test('new runtime files with an old loaded extension remain readable but refuse stateful actions', async () => {
  const h = harness('0.3.2');
  try {
    h.runtimeVersion('0.3.2');
    assert.equal((await h.api.execute({ type: 'read' })).extensionVersion, '0.1.1');
    for (const command of [{type:'social',operation:'stage'}, {type:'social',operation:'commit'}, {type:'media',operation:'begin'},
      {type:'social',operation:'prepare_confirmation',sourceToken:'12345678-1234-4123-8123-123456789012',expectedAccount:'fixture'},
      {type:'social',operation:'commit_confirmation',token:'12345678-1234-4123-8123-123456789012',expectedAccount:'fixture'},
      {type:'remote_browser',operation:'snapshot',expectedAccount:'fixture'},
      {type:'remote_view',kind:'messages',navigationToken:'12345678-1234-4123-8123-123456789012',expectedAccount:'fixture'}])
      await assert.rejects(h.api.execute(command), {code:'RUNTIME_VERSION_MISMATCH'});
    h.tab.active = true; h.focus(true);
    await assert.rejects(h.api.execute({type:'interact',snapshotId:'s',ref:'button',verb:'click'}), {code:'RUNTIME_VERSION_MISMATCH'});
    assert.ok(!h.calls.some(call => call.kind === 'interact'));
    assert.ok(!h.calls.some(call => ['remote-view','remote-browser','social-prepare-confirmation','social-commit-confirmation'].includes(call.kind)));
  } finally { h.cleanup(); }
});

test('old navigation completion cannot finish destination before target DOM is ready', async () => {
  const h = harness();
  const target = 'https://www.threads.com/@desired';
  try {
    let settled = false;
    const pending = h.api.execute({ type: 'navigate', url: target }).then(value => { settled = true; return value; });
    await delay(10);
    h.onUpdated.emit(42, { status: 'complete' }, { ...h.tab });
    await delay(20);
    assert.equal(settled, false);
    // Chrome may expose the new tab URL while the old document is still present.
    h.tab.url = target;
    await delay(170);
    assert.equal(settled, false);
    h.page.url = target;
    h.page.readyState = 'loading';
    await delay(170);
    assert.equal(settled, false);
    h.page.readyState = 'complete';
    const result = await pending;
    assert.equal(result.url, target);
    const updates = h.calls.filter(call => call.kind === 'update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].args.url, target);
    assert.equal('active' in updates[0].args, false);
    assert.ok(!h.calls.some(call => call.kind === 'focus'));
  } finally { h.cleanup(); }
});

test('interactive target DOM succeeds while Chrome still reports loading subresources', async () => {
  const h = harness();
  const target = 'https://www.threads.com/@desired';
  h.tab.url = target;
  h.tab.status = 'loading';
  h.page.url = target;
  h.page.readyState = 'interactive';
  try {
    const result = await h.api.execute({ type: 'navigate', url: target });
    assert.equal(result.url, target);
    assert.equal(result.readiness, 'interactive');
    assert.equal(result.tabStatus, 'loading');
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
    assert.ok(h.calls.filter(call => call.kind === 'script').every(call => call.args.injectImmediately === true));
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 1);
    assert.equal('hasBody' in result, false);
    assert.equal('text' in result, false);
  } finally { h.cleanup(); }
});

test('interactive readiness still rejects an old document and a textless skeleton', async () => {
  const h = harness();
  const target = 'https://www.threads.com/@desired';
  h.tab.url = target;
  h.tab.status = 'loading';
  h.page.readyState = 'interactive';
  let settled = false;
  try {
    const pending = h.api.execute({ type: 'navigate', url: target }).then(result => { settled = true; return result; });
    await delay(180);
    assert.equal(settled, false); // Chrome has target metadata, but document is old.
    h.page.url = target;
    h.page.text = '';
    h.page.rawText = '{"scriptOnlySkeleton":"not visible page content"}';
    await delay(180);
    assert.equal(settled, false);
    h.page.text = 'Visible target profile';
    const result = await pending;
    assert.equal(result.url, target);
    assert.equal(result.readiness, 'interactive');
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 1);
  } finally { h.cleanup(); }
});

test('same-URL navigation waits for a new document instead of accepting the old open-dialog DOM', async () => {
  const h = harness();
  const target = 'https://www.threads.com/@desired';
  h.tab.url = target;
  h.page.url = target;
  h.page.text = 'Old document with Followers dialog still open';
  h.commitOnUpdate(false);
  let settled = false;
  try {
    const pending = h.api.execute({ type: 'navigate', url: target }).then(result => { settled = true; return result; });
    await delay(180);
    assert.equal(settled, false);
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 1);
    // Commit can happen later than tabs.update resolution, even at identical URL.
    h.page.documentId = 'new-same-url-document';
    h.page.readyState = 'interactive';
    h.page.text = '';
    await delay(180);
    assert.equal(settled, false);
    h.page.text = 'Fresh profile without old dialog';
    const result = await pending;
    assert.equal(result.documentChanged, true);
    assert.equal(result.url, target);
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 1);
  } finally { h.cleanup(); }
});

test('unavailable navigation document identity fails before issuing a navigation', async () => {
  const h = harness();
  h.page.documentId = '';
  try {
    await assert.rejects(h.api.execute({ type: 'navigate', url: 'https://www.threads.com/@desired' }), { code: 'NAVIGATION_CONTEXT_UNVERIFIED' });
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 0);
    assert.equal(h.api.navigationCount(), 0);
  } finally { h.cleanup(); }
});

test('navigation timeout codes distinguish pending scripts from observed readiness failures without page text', async () => {
  for (const phase of ['BASELINE_PROBE', 'UPDATE', 'ROUTE', 'PROBE', 'PROBE_ERROR', 'DOCUMENT', 'DOM', 'CONTENT']) {
    const h = harness();
    const target = 'https://www.threads.com/@desired';
    h.tab.url = target;
    h.page.url = target;
    let release: (() => void) | undefined;
    const gate = () => new Promise<void>(resolve => { release = resolve; });
    if (phase === 'BASELINE_PROBE') h.holdBaselineProbe(gate());
    if (phase === 'UPDATE') h.holdUpdate(gate());
    if (phase === 'ROUTE') h.tab.url = 'https://www.threads.com/@other';
    if (phase === 'PROBE') h.holdNavigationProbe(gate());
    if (phase === 'PROBE_ERROR') h.failNavigationProbe();
    if (phase === 'DOCUMENT') h.commitOnUpdate(false);
    if (phase === 'DOM') h.page.readyState = 'loading';
    if (phase === 'CONTENT') h.page.text = '';
    try {
      const pending = h.api.execute({ type: 'navigate', url: target });
      const rejected = assert.rejects(pending, error => {
        assert.equal((error as any).code, `NAVIGATION_TIMEOUT_${phase}`);
        assert.equal(String(error).includes(target), false);
        assert.equal(String(error).includes('Fixture content'), false);
        return true;
      });
      await delay(0);
      h.expireNavigation();
      await rejected;
      release?.();
      await delay(0);
      assert.equal(h.calls.filter(call => call.kind === 'update').length, phase === 'BASELINE_PROBE' ? 0 : 1);
      assert.equal(h.api.navigationCount(), 0);
    } finally { release?.(); h.cleanup(); }
  }
});

test('disconnect immediately stops navigation readiness polling and never replays navigation', async () => {
  const h = harness();
  try {
    const pending = h.api.execute({ type: 'navigate', url: 'https://www.threads.com/@desired' });
    const rejected = assert.rejects(pending, { code: 'BRIDGE_DISCONNECTED' });
    await delay(10);
    assert.equal(h.api.navigationCount(), 1);
    h.api.disconnect();
    await rejected;
    assert.equal(h.api.navigationCount(), 0);
    const count = h.calls.length;
    await delay(180);
    assert.equal(h.calls.length, count);
    assert.equal(h.calls.filter(call => call.kind === 'update').length, 1);
  } finally { h.cleanup(); }
});
