import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('remote view runtime uses a fixed route and a fresh single-use account, draft and document binding',
  { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async t => {
  const bundle = await build({ entryPoints: ['src/page-runtime.ts'], bundle: true, platform: 'browser', format: 'iife',
    globalName: 'ThreadsMCP', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    const navigationRequests: string[] = [];
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest()) navigationRequests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><a id="viewer" href="/@fixture" aria-label="Profile">Profile</a><p>Isolated fixture</p><input id="search" type="search" aria-label="Search"></body></html>' });
    });
    const page = await context.newPage();
    let sequence = 0;
    async function reset() {
      await page.goto(`https://www.threads.com/@fixture?fixture=${++sequence}`);
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      return readToken();
    }
    async function readToken(): Promise<string> {
      const result = await page.evaluate(() => (window as any).ThreadsMCP.readPage());
      assert.equal(result.viewer.username, 'fixture');
      assert.equal(result.composerState.present, false);
      assert.equal(typeof result.remoteNavigationToken, 'string');
      assert.ok(result.remoteNavigationToken.length > 0);
      return result.remoteNavigationToken;
    }
    const command = (navigationToken: string) => ({ type: 'remote_view', kind: 'notifications', expectedAccount: 'fixture', navigationToken });
    async function rejectsWithoutNavigation(input: Record<string, unknown>, pattern: RegExp) {
      const before = page.url(), count = navigationRequests.length;
      await assert.rejects(page.evaluate(input => (window as any).ThreadsMCP.remoteView(input), input), pattern);
      assert.equal(page.url(), before);
      assert.equal(navigationRequests.length, count);
    }

    for (const [kind, path] of [['notifications','/activity'], ['messages','/messages/']]) {
      await t.test(`fresh token dispatches only ${path} once and synchronous replay fails`, async () => {
        const token = await reset();
        const count = navigationRequests.length;
        const destination = `https://www.threads.com${path}`;
        const navigation = page.waitForURL(destination);
        const result = await page.evaluate(input => {
          const api = (window as any).ThreadsMCP;
          const first = api.remoteView(input);
          let replay = '';
          try { api.remoteView(input); replay = 'unexpected-success'; } catch (error) { replay = String(error); }
          return { first, replay };
        }, { ...command(token), kind });
        await navigation;
        assert.deepEqual(result.first, { dispatched: true, verified: false, destination });
        assert.match(result.replay, /REMOTE_VIEW_STALE/);
        assert.deepEqual(navigationRequests.slice(count), [destination]);
      });
    }

    await t.test('wrong expected account and a changed viewer are rejected without navigation', async () => {
      let token = await reset();
      await rejectsWithoutNavigation({ ...command(token), expectedAccount: 'other' }, /REMOTE_VIEW_STALE|ACCOUNT_MISMATCH/);
      token = await reset();
      await page.locator('#viewer').evaluate(el => el.setAttribute('href', '/@other'));
      await rejectsWithoutNavigation(command(token), /ACCOUNT_MISMATCH/);
    });

    await t.test('trusted keyboard takeover and trusted search input invalidate a token', async () => {
      let token = await reset();
      await page.keyboard.press('Escape');
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
      token = await reset();
      await page.locator('#search').fill('manual search');
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
    });

    await t.test('a draft appearing after the read is preserved and consumes the navigation token', async () => {
      const token = await reset();
      await page.evaluate(() => {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<textarea aria-label="New thread">Keep this draft intact</textarea>';
        document.body.append(dialog);
      });
      await rejectsWithoutNavigation(command(token), /COMPOSER_BUSY/);
      assert.equal(await page.locator('textarea').inputValue(), 'Keep this draft intact');
      await page.locator('[role="dialog"]').evaluate(el => el.remove());
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
    });

    await t.test('route replacement and a new same-URL document reject the old binding', async () => {
      let token = await reset();
      await page.evaluate(() => history.replaceState(null, '', '/@elsewhere'));
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
      token = await reset();
      await page.reload();
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
    });

    await t.test('unknown kinds, extra URL/script fields and missing tokens cannot navigate or execute JavaScript', async () => {
      const token = await reset();
      for (const input of [
        { ...command(token), kind: 'settings' },
        { ...command(token), kind: 'javascript:window.arbitraryExecution=true' },
        { ...command(token), url: 'https://example.invalid/' },
        { ...command(token), code: 'window.arbitraryExecution=true' },
        { type: 'remote_view', kind: 'notifications', expectedAccount: 'fixture' },
      ]) await rejectsWithoutNavigation(input, /INVALID_COMMAND|REMOTE_VIEW_STALE/);
      assert.equal(await page.evaluate(() => (window as any).arbitraryExecution), undefined);
      assert.ok(navigationRequests.every(url => new URL(url).hostname === 'www.threads.com'));
    });

    await t.test('thirty-second expiry and a superseding read invalidate earlier tokens', async () => {
      let token = await reset();
      await page.evaluate(() => { const later = Date.now() + 30_001; Date.now = () => later; });
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
      token = await reset();
      const newer = await readToken(); assert.notEqual(newer, token);
      await rejectsWithoutNavigation(command(token), /REMOTE_VIEW_STALE/);
    });
  } finally { await browser.close(); }
});
