import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { BrowserDriver } from '../src/driver.js';
import type { ThreadsService } from '../src/service.js';
import { RemoteBrowserController } from '../src/remote-browser.js';
import { checkedRemoteBrowserUrl, validateRemoteBrowserCommand } from '../src/remote-browser-runtime.js';

const target = 'https://www.threads.com/@author/post/Post1';
class FixtureDriver implements BrowserDriver {
  commands: Record<string, unknown>[] = [];
  url = 'https://www.threads.com/';
  destination = target;
  snapshotId = randomUUID();
  token = randomUUID();
  gate?: () => Promise<void>;
  uncertainConsume = false;
  account = 'fixture';
  status() { return {}; }
  async close() {}
  async command<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command.type !== 'remote_browser') throw new Error('Raw driver cannot navigate or interact');
    if (command.operation === 'snapshot' || command.operation === 'scroll') {
      this.snapshotId = randomUUID();
      return { snapshotId: this.snapshotId, account: this.account, url: this.url, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        elements: [{ ref: 'r1', kind: 'navigation', name: 'untrusted name', verb: 'click', url: target }], scope: 'public-read-navigation', warnings: ['untrusted warning'] } as T;
    }
    if (command.operation === 'prepare') return { token: this.token, account: this.account, sourceUrl: this.url, destination: this.destination, expiresAt: new Date(Date.now() + 60_000).toISOString(), kind: 'navigation' } as T;
    if (command.operation === 'consume') {
      await this.gate?.();
      if (this.uncertainConsume) throw new Error('BRIDGE_TIMEOUT');
      return { account: this.account, sourceUrl: this.url, destination: this.destination, kind: 'navigation', dispatched: true, verified: false } as T;
    }
    throw new Error('Unexpected command');
  }
}
function fixture(writesEnabled = true) {
  const raw = new FixtureDriver(), navigations: Record<string, unknown>[] = [];
  let allowed = true;
  const service = {
    config: { writesEnabled }, serial: <T>(fn: () => Promise<T>) => fn(),
    driver: { command: async (command: Record<string, unknown>) => { assert.equal(command.type, 'navigate'); navigations.push(command); raw.url = String(command.url); } },
  } as unknown as ThreadsService;
  const controller = new RemoteBrowserController(service, raw, () => { if (!allowed) throw new Error('ACCESS_CHANGED'); });
  return { raw, controller, navigations, revoke: () => { allowed = false; controller.invalidate(); } };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const snap = await f.controller.snapshot({ expectedAccount: 'fixture' });
  return f.controller.prepare({ expectedAccount: 'fixture', snapshotId: snap.snapshotId, ref: 'r1', verb: 'click', purpose: 'Read the public post' });
}

test('remote browser host consumes one atomic runtime navigation without host navigation or automatic reads', async () => {
  const f = fixture(); const action = await prepared(f);
  assert.equal(action.dispatched, false); assert.equal(f.navigations.length, 0);
  const result = await f.controller.execute({ id: action.id, expectedAccount: 'fixture' });
  assert.equal(result.status, 'navigation-unverified'); assert.equal(result.verified, false); assert.deepEqual(f.navigations, []);
  assert.ok(f.raw.commands.every(command => command.type === 'remote_browser'));
  assert.deepEqual(f.raw.commands.map(command => command.operation), ['snapshot', 'prepare', 'consume']);
  assert.doesNotMatch(JSON.stringify(result), /untrusted/);
  await assert.rejects(f.controller.execute({ id: action.id, expectedAccount: 'fixture' }), /denied or changed/);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.raw.commands.filter(command => command.operation === 'consume').length, 1);
});

test('remote browser host rejects unsupported verbs, unknown snapshots and private destinations', async () => {
  const f = fixture(); const snap = await f.controller.snapshot({ expectedAccount: 'fixture' });
  for (const verb of ['press', 'select', 'check', 'eval']) await assert.rejects(f.controller.prepare({ expectedAccount: 'fixture', snapshotId: snap.snapshotId, ref: 'r1', verb, purpose: 'Read' }));
  await assert.rejects(f.controller.prepare({ expectedAccount: 'fixture', snapshotId: randomUUID(), ref: 'r1', verb: 'click', purpose: 'Read' }));
  f.raw.destination = 'https://www.threads.com/settings';
  await assert.rejects(f.controller.prepare({ expectedAccount: 'fixture', snapshotId: snap.snapshotId, ref: 'r1', verb: 'click', purpose: 'Read' }));
  await assert.rejects(f.controller.snapshot({ expectedAccount: 'fixture', url: 'https://www.threads.com/messages' }));
  await assert.rejects(f.controller.snapshot({ expectedAccount: 'fixture', url: target }));
  assert.equal(f.navigations.length, 0);
});

test('remote browser host revocation invalidates snapshots and does not replay a pending consume', async () => {
  const f = fixture(); const action = await prepared(f);
  let release!: () => void;
  f.raw.gate = () => new Promise(resolve => { release = resolve; });
  const executing = f.controller.execute({ id: action.id, expectedAccount: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  f.revoke(); release();
  await assert.rejects(executing, /ACCESS_CHANGED/);
  assert.equal(f.navigations.length, 0);
  await assert.rejects(f.controller.execute({ id: action.id, expectedAccount: 'fixture' }));
  const disabled = fixture(false);
  await assert.rejects(disabled.controller.snapshot({ expectedAccount: 'fixture' }));
  assert.equal(disabled.raw.commands.length, 0);
});

test('remote browser host never retries or auto-snapshots an uncertain navigation receipt', async () => {
  const f = fixture(); const action = await prepared(f);
  f.raw.uncertainConsume = true;
  await assert.rejects(f.controller.execute({ id: action.id, expectedAccount: 'fixture' }), /BRIDGE_TIMEOUT/);
  await assert.rejects(f.controller.execute({ id: action.id, expectedAccount: 'fixture' }));
  assert.deepEqual(f.raw.commands.map(command => command.operation), ['snapshot', 'prepare', 'consume']);
  assert.equal(f.navigations.length, 0);
});

test('remote browser route and transport contracts reject alternate command surfaces', () => {
  for (const url of ['https://www.threads.com/messages', 'https://www.threads.com/activity', 'https://www.threads.com/settings', 'https://www.threads.com/login',
    'https://foreign.invalid/@fixture', 'javascript:alert(1)', 'https://www.threads.com/@fixture?delete=1', 'https://www.threads.com/search?q=hello&redirect=https://foreign.invalid', 'https://www.threads.com:8443/']) assert.throws(() => checkedRemoteBrowserUrl(url));
  assert.equal(checkedRemoteBrowserUrl('https://www.threads.com/following/'), 'https://www.threads.com/following');
  assert.throws(() => validateRemoteBrowserCommand({ type: 'remote_browser', operation: 'snapshot', expectedAccount: 'fixture', script: 'secret' }));
  assert.throws(() => validateRemoteBrowserCommand({ type: 'remote_browser', operation: 'scroll', expectedAccount: 'fixture', pixels: 2001 }));
  assert.throws(() => validateRemoteBrowserCommand({ type: 'remote_browser', operation: 'interact', expectedAccount: 'fixture' }));
  assert.throws(() => validateRemoteBrowserCommand({ type: 'remote_browser', operation: '__proto__' }), /INVALID_COMMAND/);
});

test('remote browser runtime vets actual DOM refs without generic effects or private text', { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async t => {
  const bundle = await build({ entryPoints: ['src/remote-browser-runtime.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'Fixture', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const html = `<!doctype html><html><head><base href="https://foreign.invalid/"></head><body style="height:5000px">
    <a href="/@fixture" aria-label="Profile">Profile</a><a id="post" href="/@author/post/Post1">Public post</a>
    <a href="/following">Following</a><a href="/saved">Saved</a><a href="/liked">Liked</a>
    <input type="search" aria-label="Search" id="search">
    <button onclick="window.effects++">Like</button><a href="/@other" aria-label="Delete account">Sneaky</a>
    <a href="/messages">Messages</a><a href="/settings">Settings</a><a href="/activity">Activity</a>
    <a href="https://foreign.invalid/@author">External</a><a href="javascript:window.effects++">Run</a>
    <a href="/@other" onclick="window.effects++">Custom handler</a><p>PRIVATE UNRELATED DOM SECRET</p>
    <a href="#">Placeholder control</a><a href="">Empty control</a>
    <script>window.effects=0</script></body></html>`;
  const documentRequests: string[] = [];
  await context.route('**/*', route => {
    if (route.request().resourceType() === 'document') { documentRequests.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: html }); }
    return route.abort();
  });
  const page = await context.newPage();
  const reset = async (url = 'https://www.threads.com/') => { await page.goto(url); await page.addScriptTag({ content: bundle.outputFiles[0]!.text }); };
  const command = (value: Record<string, unknown>) => page.evaluate(value => (window as any).Fixture.remoteBrowser(value), { expectedAccount: 'fixture', ...value });
  const snap = () => command({ operation: 'snapshot' });
  const prep = (snapshot: any, ref: any, extra: Record<string, unknown> = {}) => command({ operation: 'prepare', snapshotId: snapshot.snapshotId, ref: ref.ref, verb: ref.verb, purpose: 'Inspect public material', ...extra });
  try {
    await t.test('snapshot exposes only derived semantic labels and approved routes', async () => {
      await reset(); const snapshot = await snap();
      assert.equal(snapshot.elements.length, 6);
      assert.doesNotMatch(JSON.stringify(snapshot.elements), /SECRET|Sneaky|Delete|foreign|javascript|settings|messages|activity|Custom handler/);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE UNRELATED DOM SECRET/);
      assert.ok(snapshot.elements.every((ref: any) => ref.kind === 'navigation' || ref.kind === 'search'));
    });
    await t.test('search atomically navigates its approved URL once without filling, clicking or submitting', async () => {
      await reset(); const snapshot = await snap();
      const prepared = await prep(snapshot, snapshot.elements.find((ref: any) => ref.kind === 'search'), { value: 'public agents' });
      assert.equal(await page.locator('#search').inputValue(), '');
      const requestsBefore = documentRequests.length;
      const [, receipt] = await Promise.all([page.waitForURL(prepared.destination), page.evaluate(token => {
        const result = (window as any).Fixture.remoteBrowser({ operation: 'consume', token, expectedAccount: 'fixture' });
        let secondError = ''; try { (window as any).Fixture.remoteBrowser({ operation: 'consume', token, expectedAccount: 'fixture' }); } catch (error) { secondError = String(error); }
        return { result, secondError, value: document.querySelector<HTMLInputElement>('#search')!.value, effects: (window as any).effects };
      }, prepared.token)]);
      assert.equal(new URL(page.url()).searchParams.get('q'), 'public agents');
      assert.equal(receipt.result.dispatched, true); assert.equal(receipt.result.verified, false);
      assert.equal(receipt.effects, 0); assert.equal(receipt.value, '');
      assert.match(receipt.secondError, /PREPARATION_MISSING/);
      assert.deepEqual(documentRequests.slice(requestsBefore), [prepared.destination]);
    });
    await t.test('vetted anchor navigation dispatches exactly the bound destination', async () => {
      await reset(); const snapshot = await snap(), ref = snapshot.elements.find((ref: any) => ref.url === target);
      const prepared = await prep(snapshot, ref), requestsBefore = documentRequests.length;
      const [, consumed] = await Promise.all([page.waitForURL(target), command({ operation: 'consume', token: prepared.token })]);
      assert.equal(consumed.dispatched, true); assert.equal(consumed.verified, false);
      assert.deepEqual(documentRequests.slice(requestsBefore), [target]);
    });
    await t.test('href mutation, route/account change, and trusted takeover invalidate refs', async () => {
      for (const change of ['href', 'route', 'account', 'manual', 'draft']) {
        await reset(); const snapshot = await snap(), ref = snapshot.elements.find((ref: any) => ref.url === target);
        const prepared = await prep(snapshot, ref);
        if (change === 'manual') await page.locator('#search').press('ArrowLeft');
        else await page.evaluate(change => {
          if (change === 'href') document.querySelector('#post')!.setAttribute('href', '/@other/post/Other');
          if (change === 'route') history.pushState({}, '', 'https://www.threads.com/@another');
          if (change === 'account') document.querySelector('[aria-label=Profile]')!.setAttribute('href', '/@other');
          if (change === 'draft') { const editor = document.createElement('textarea'); editor.value = 'New user draft'; document.body.append(editor); }
        }, change);
        const requestsBefore = documentRequests.length;
        await assert.rejects(command({ operation: 'consume', token: prepared.token }), /STALE|MISSING|ACCOUNT_MISMATCH|COMPOSER_BUSY/);
        assert.equal(await page.evaluate(() => (window as any).effects), 0);
        assert.equal(documentRequests.length, requestsBefore);
        if (change === 'draft') assert.equal(await page.locator('textarea').inputValue(), 'New user draft');
      }
    });
    await t.test('drafts are preserved and unsafe current routes never return a snapshot', async () => {
      await reset();
      await page.evaluate(() => { const editor = document.createElement('textarea'); editor.value = 'User draft'; document.body.append(editor); });
      await assert.rejects(snap(), /COMPOSER_BUSY/);
      assert.equal(await page.locator('textarea').inputValue(), 'User draft');
      for (const route of ['messages', 'settings', 'activity']) { await reset(`https://www.threads.com/${route}`); await assert.rejects(snap(), /ROUTE_DENIED/); }
    });
    await t.test('expired runtime preparation cannot be consumed', async () => {
      await reset(); const snapshot = await snap(), prepared = await prep(snapshot, snapshot.elements[0]);
      await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 61_000; });
      await assert.rejects(command({ operation: 'consume', token: prepared.token }), /STALE/);
      assert.equal(await page.evaluate(() => (window as any).effects), 0);
    });
    await t.test('scroll is bounded and replaces prior refs; explicit invalidation revokes snapshot', async () => {
      await reset(); const old = await snap();
      await assert.rejects(command({ operation: 'scroll', pixels: 2001 }), /INVALID_COMMAND/);
      const current = await command({ operation: 'scroll', pixels: 400 });
      assert.notEqual(current.snapshotId, old.snapshotId);
      assert.equal(await page.evaluate(() => scrollY), 400);
      await assert.rejects(prep(old, old.elements[0]), /STALE/);
      await page.evaluate(() => (window as any).Fixture.cancelRemoteBrowserActions());
      await assert.rejects(prep(current, current.elements[0]), /STALE/);
    });
  } finally { await context.close(); await browser.close(); }
});
