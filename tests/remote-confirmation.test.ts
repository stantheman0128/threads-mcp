import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('delete runtime keeps final confirmation separate, bound and once-only under actual DOM changes and trusted takeover',
  { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async () => {
  const bundle = await build({ entryPoints: ['src/social-runtime.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'SocialFixture', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    const page = await context.newPage();
    const request = { kind: 'delete', targetUrl: 'https://www.threads.com/@fixture/post/OWN' };
    async function reset() {
      await page.goto(request.targetUrl);
      await page.setContent('<a id="viewer" href="/@fixture" aria-label="Profile">Profile</a><article id="own-card"><a href="/@fixture">fixture</a><a href="/@fixture/post/OWN">Own post</a><p>Exact own post</p><button>Like</button><button id="more" aria-haspopup="menu">More</button></article>');
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await page.evaluate(() => {
        (window as any).firstDeletes = 0; (window as any).finalDeletes = 0;
        document.getElementById('more')!.onclick = () => {
          const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
          menu.innerHTML = '<button role="menuitem" id="first-delete">Delete</button>'; document.body.append(menu);
          document.getElementById('first-delete')!.onclick = () => {
            (window as any).firstDeletes++;
            menu.remove();
            const dialog = document.createElement('div'); dialog.id = 'confirmation'; dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = '<h2>Delete post?</h2><p>This cannot be undone.</p><a href="/@fixture/post/OWN">Exact target</a><button id="cancel">Cancel</button><button id="final-delete">Delete</button>';
            document.body.append(dialog);
            document.getElementById('final-delete')!.onclick = () => {
              (window as any).finalDeletes++; document.getElementById('own-card')!.remove(); dialog.remove();
            };
          };
        };
      });
      return page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    }
    async function firstDelete() {
      const source = await reset();
      await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), source.token);
      const result = await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request, token: source.token });
      assert.equal(result.state, 'confirmation-required'); assert.equal(result.verified, false);
      assert.equal(await page.evaluate(() => (window as any).firstDeletes), 1);
      assert.equal(await page.evaluate(() => (window as any).finalDeletes), 0);
      return source;
    }
    const source = await firstDelete();
    const confirmation = await page.evaluate(token => (window as any).SocialFixture.socialPrepareConfirmation(token, 'fixture'), source.token);
    assert.equal(confirmation.sourceToken, source.token); assert.notEqual(confirmation.token, source.token);
    assert.equal(await page.evaluate(() => (window as any).finalDeletes), 0);
    const outcome = await page.evaluate(token => (window as any).SocialFixture.socialCommitConfirmation(token, 'fixture'), confirmation.token);
    assert.equal(outcome.dispatched, true); assert.equal(outcome.verified, false); assert.equal(outcome.outcome, 'outcome-uncertain');
    assert.equal(await page.evaluate(() => (window as any).finalDeletes), 1);
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommitConfirmation(token, 'fixture'), confirmation.token), /INVALID_ACTION/);

    for (const failure of ['wrong-account','wrong-target','heading','ambiguous']) {
      const source = await firstDelete();
      if (failure === 'wrong-target') await page.locator('#confirmation a').evaluate(el => el.setAttribute('href', '/@other/post/OTHER'));
      if (failure === 'heading') await page.locator('#confirmation h2').evaluate(el => el.textContent = 'Unrelated confirmation');
      if (failure === 'ambiguous') await page.evaluate(() => document.body.append(document.getElementById('confirmation')!.cloneNode(true)));
      await assert.rejects(page.evaluate(({ token, account }) => (window as any).SocialFixture.socialPrepareConfirmation(token, account),
        { token: source.token, account: failure === 'wrong-account' ? 'other' : 'fixture' }), /ACCOUNT_MISMATCH|TARGET_CHANGED|CONFIRMATION_/);
      assert.equal(await page.evaluate(() => (window as any).finalDeletes), 0);
    }

    for (const failure of ['control','dialog-replaced','dialog-reinserted','source-replaced','source-text','account','route','expired','manual']) {
      const source = await firstDelete();
      const confirmation = await page.evaluate(token => (window as any).SocialFixture.socialPrepareConfirmation(token, 'fixture'), source.token);
      if (failure === 'control') await page.locator('#final-delete').evaluate(el => el.setAttribute('aria-disabled', 'true'));
      if (failure === 'dialog-replaced') await page.locator('#confirmation').evaluate(el => el.replaceWith(el.cloneNode(true)));
      if (failure === 'dialog-reinserted') await page.locator('#confirmation').evaluate(el => { el.remove(); document.body.append(el); });
      if (failure === 'source-replaced') await page.locator('#own-card').evaluate(el => el.replaceWith(el.cloneNode(true)));
      if (failure === 'source-text') await page.locator('#own-card p').evaluate(el => el.textContent = 'Changed source text');
      if (failure === 'account') await page.locator('#viewer').evaluate(el => el.setAttribute('href', '/@other'));
      if (failure === 'route') await page.evaluate(() => history.pushState(null, '', '/@fixture/post/OTHER'));
      if (failure === 'expired') await page.evaluate(() => { const later = Date.now() + 90_001; Date.now = () => later; });
      if (failure === 'manual') await page.keyboard.press('Escape');
      await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommitConfirmation(token, 'fixture'), confirmation.token),
        /INVALID_ACTION|STALE_ELEMENT|EXPIRED_ACTION|ACCOUNT_MISMATCH|TARGET_CHANGED|CONFIRMATION_/);
      assert.equal(await page.evaluate(() => (window as any).finalDeletes), 0);
      await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommitConfirmation(token, 'fixture'), confirmation.token), /INVALID_ACTION/);
    }
  } finally { await browser.close(); }
});
