import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { SocialActions, type SocialDriver, type SocialStage, type SocialObservation } from '../src/social-actions.js';
import { ThreadsError } from '../src/types.js';

const request = { kind: 'like' as const, targetUrl: 'https://www.threads.com/@writer/post/EXACT' };
const before: SocialObservation = { account: 'fixture', url: request.targetUrl, targetUrl: request.targetUrl, state: 'like', verified: false, evidence: [] };
const stage: SocialStage = { token: 'runtime-token', account: 'fixture', url: request.targetUrl, request, before, noop: false };
class Fake implements SocialDriver {
  commands: Record<string, unknown>[] = [];
  after: SocialObservation = { ...before, state: 'unlike', verified: true };
  staged: SocialStage = stage;
  inspectErrors: string[] = [];
  uncertain = false;
  async command<T>(command: Record<string, unknown>): Promise<T> {
    this.commands.push(command);
    if (command.operation === 'stage') return structuredClone(this.staged) as T;
    if (command.operation === 'commit') { if (this.uncertain) throw new Error('response lost after send'); return { dispatched: true, noop: false } as T; }
    const error = this.inspectErrors.shift(); if (error) throw new ThreadsError(error, 'fixture read failure');
    return structuredClone(this.after) as T;
  }
}
test('social writes disabled prevents staging and dispatch', async () => {
  const driver = new Fake(); const actions = new SocialActions(driver, { writesEnabled: false, minActionIntervalMs: 0 });
  await assert.rejects(actions.prepare(request), /THREADS_ALLOW_WRITES/);
  await assert.rejects(actions.execute('x', 'fixture'), /THREADS_ALLOW_WRITES/);
  assert.equal(driver.commands.length, 0);
  assert.equal((await actions.inspect(request)).state, 'unlike');
  assert.deepEqual(driver.commands.map(command => command.operation), ['inspect']);
});
test('social execution verifies application state once and consumes the token', async () => {
  const driver = new Fake(); const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 0 });
  const prepared = await actions.prepare(request); const result = await actions.execute(prepared.id, '@fixture');
  assert.equal(result.verified, true); assert.equal(result.outcome, 'verified');
  await assert.rejects(actions.execute(prepared.id, 'fixture'), /already consumed/);
  assert.deepEqual(driver.commands.map(c => c.operation), ['stage','commit','inspect']);
});
test('account mismatch, expiry and cooldown fail before another dispatch', async () => {
  const driver = new Fake(); let now = 0;
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 8000, now: () => now });
  let prepared = await actions.prepare(request); await assert.rejects(actions.execute(prepared.id, 'wrong'), /Expected account/);
  prepared = await actions.prepare(request); now = 100_000; await assert.rejects(actions.execute(prepared.id, 'fixture'), /Prepare the social action/);
  prepared = await actions.prepare(request); await actions.execute(prepared.id, 'fixture');
  prepared = await actions.prepare(request); await assert.rejects(actions.execute(prepared.id, 'fixture'), /cooldown/);
  assert.equal(driver.commands.filter(c => c.operation === 'commit').length, 1);
});
test('lost commit result and changed-account verification never replay or claim success', async () => {
  const driver = new Fake(); driver.uncertain = true;
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 0 });
  let prepared = await actions.prepare(request); let result = await actions.execute(prepared.id, 'fixture');
  assert.equal(result.outcome, 'outcome-uncertain'); await assert.rejects(actions.execute(prepared.id, 'fixture'), /consumed/);
  driver.uncertain = false; driver.after.account = 'other';
  prepared = await actions.prepare(request); result = await actions.execute(prepared.id, 'fixture');
  assert.equal(result.verified, false); assert.equal(driver.commands.filter(c => c.operation === 'commit').length, 2);
});
test('unchanged state after click is uncertain after bounded read-only checks', async () => {
  const driver = new Fake(); driver.after = before;
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 0, verificationAttempts: 3, sleep: async () => {} });
  const prepared = await actions.prepare(request); const result = await actions.execute(prepared.id, 'fixture');
  assert.equal(result.verified, false);
  assert.equal(driver.commands.filter(c => c.operation === 'commit').length, 1);
  assert.equal(driver.commands.filter(c => c.operation === 'inspect').length, 3);
});
test('transient post-commit UI readiness retries only inspection, never account errors or commit', async () => {
  const driver = new Fake(); driver.inspectErrors = ['UI_NOT_READY', 'AMBIGUOUS_UI'];
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 0, verificationAttempts: 3, sleep: async () => {} });
  let prepared = await actions.prepare(request); let result = await actions.execute(prepared.id, 'fixture');
  assert.equal(result.verified, true);
  assert.equal(driver.commands.filter(c => c.operation === 'commit').length, 1);
  assert.equal(driver.commands.filter(c => c.operation === 'inspect').length, 3);
  driver.inspectErrors = ['ACCOUNT_MISMATCH', 'UI_NOT_READY'];
  prepared = await actions.prepare(request); result = await actions.execute(prepared.id, 'fixture');
  assert.equal(result.verified, false);
  assert.deepEqual(driver.inspectErrors, ['UI_NOT_READY']);
});
test('publication verification accepts only a correlated new own-post route', async () => {
  const driver = new Fake();
  const publish = { kind: 'publish' as const, targetUrl: 'https://www.threads.com/', text: 'approved text' };
  driver.staged = { ...stage, url: publish.targetUrl, request: publish };
  driver.after = { ...before, url: 'https://www.threads.com/@fixture/post/NEW', postUrl: 'https://www.threads.com/@fixture/post/NEW', targetUrl: publish.targetUrl, verified: true };
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 0 });
  let prepared = await actions.prepare(publish); assert.equal((await actions.execute(prepared.id, 'fixture')).verified, true);
  driver.after = { ...driver.after, url: 'https://www.threads.com/@other/post/NEW', postUrl: 'https://www.threads.com/@other/post/NEW' };
  prepared = await actions.prepare(publish); assert.equal((await actions.execute(prepared.id, 'fixture')).verified, false);
});
test('shared write reservation replaces local cooldown and is skipped for no-op actions', async () => {
  const driver = new Fake(); let reserved = 0;
  const actions = new SocialActions(driver, { writesEnabled: true, minActionIntervalMs: 100_000, reserveWrite: () => { reserved++; if (reserved === 2) throw new ThreadsError('ACTION_COOLDOWN', 'shared cooldown'); } });
  let prepared = await actions.prepare(request); assert.equal((await actions.execute(prepared.id, 'fixture')).verified, true);
  prepared = await actions.prepare(request); await assert.rejects(actions.execute(prepared.id, 'fixture'), /shared cooldown/);
  assert.equal(driver.commands.filter(c => c.operation === 'commit').length, 1);
  driver.staged = { ...stage, noop: true };
  prepared = await actions.prepare(request); await actions.execute(prepared.id, 'fixture');
  assert.equal(reserved, 2);
});

test('social DOM runtime: exact target, single-use, stale state, safe composer and truthful verification', { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async () => {
  const bundle = await build({ entryPoints: ['src/social-runtime.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'SocialFixture', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    const page = await context.newPage();
    const reset = async (path: string, content: string) => {
      await page.goto(`https://www.threads.com${path}`);
      await page.setContent(`<a href="/@fixture" aria-label="Profile">Profile</a>${content}`);
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    };
    const card = '<article><a href="/@writer/post/EXACT">Target</a><p>target text</p><button aria-label="Like" onclick="this.setAttribute(\'aria-label\',\'Unlike\');window.clicks=(window.clicks||0)+1">Like</button></article>';
    await reset('/@writer/post/EXACT', card);
    let prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    assert.equal(await page.evaluate(() => (window as any).clicks || 0), 0);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal((await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request, token: prepared.token })).verified, true);
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /consumed/);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    assert.equal(prepared.noop, true);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    await reset('/@writer/post/EXACT', '<main>' + card.replace('</article>',
      '<a href="/insights/post/EXACT">Post insights</a><a href="https://example.org/@other/post/EXTERNAL">External reference</a><a href="javascript:/post/INVALID">Invalid reference</a></article>') +
      '<article id="reply"><a href="/@reader/post/REPLY">Reply</a><p>A different post</p><button aria-label="Like">Like</button></article></main>');
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal((await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request, token: prepared.token })).verified, true);
    assert.equal(await page.locator('#reply button').getAttribute('aria-label'), 'Like');
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    await reset('/@writer/post/EXACT', '<article><a href="/@writer/post/EXACT">Root</a><a href="/insights/post/EXACT">Insights</a>' +
      '<button><svg aria-label=""></svg>收回讚193</button><button id="already-replied">已回覆</button>' +
      '<button id="repost-menu" aria-haspopup="dialog">轉發3</button><button>分享82</button><button aria-haspopup="menu">更多</button></article>');
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    assert.equal(prepared.noop, true);
    assert.equal(prepared.before.state, 'unlike');
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    await page.evaluate(() => {
      document.getElementById('repost-menu')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'dialog'); menu.innerHTML = '<button>轉發</button>'; document.body.append(menu);
      };
      document.getElementById('already-replied')!.onclick = () => {
        const composer = document.createElement('div'); composer.setAttribute('role', 'dialog');
        composer.innerHTML = '<a href="/@writer/post/EXACT">Source</a><textarea></textarea><button>回覆</button>'; document.body.append(composer);
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), { ...request, kind: 'repost' });
    assert.equal(prepared.noop, false);
    await page.locator('[role=dialog]').evaluate(el => el.remove());
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), { ...request, kind: 'reply', text: 'approved reply' });
    assert.equal(await page.locator('textarea').inputValue(), 'approved reply');
    assert.equal(prepared.before.verified, false);
    await reset('/@writer/post/EXACT', '<article><a href="/@writer">writer</a><a href="/@writer/post/EXACT">Root</a><time datetime="2026-01-01T00:00:00Z">Jan 1</time><p>Complete source body</p><button>Like</button><button id="reply-preview">已回覆</button></article>');
    await page.evaluate(() => {
      document.getElementById('reply-preview')!.onclick = () => {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<h1>回覆</h1><section id="source-preview"><a href="/@writer">writer</a><time datetime="2026-01-01T00:00:00Z">Jan 1</time><p>Complete source body</p><video></video></section><div data-barcelona-composer-body="true"><div contenteditable="true" role="textbox" data-lexical-editor="true"></div><button>發佈</button></div>';
        document.body.append(dialog);
      };
    });
    const replyRequest = { ...request, kind: 'reply', text: 'Approved body' };
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), replyRequest);
    assert.equal(await page.locator('[contenteditable]').innerText(), replyRequest.text);
    await page.locator('#source-preview p').evaluate(el => el.textContent = 'Changed source body');
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /TARGET_CHANGED/);
    await page.locator('[role=dialog]').evaluate(el => el.remove());
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), replyRequest);
    await page.evaluate(() => (window as any).SocialFixture.cancelSocialActions());
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /INVALID_ACTION/);
    await reset('/', '<button>Create</button>');
    const cancelled = await page.evaluate(async () => {
      const pending = (window as any).SocialFixture.socialStage({ kind: 'publish', targetUrl: location.href, text: 'Never fill after Stop' });
      (window as any).SocialFixture.cancelSocialActions();
      const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<textarea></textarea><button>Post</button>'; document.body.append(dialog);
      try { await pending; return 'unexpected-success'; } catch (error) { return String(error); }
    });
    assert.match(cancelled, /ACTION_CANCELLED/);
    assert.equal(await page.locator('textarea').inputValue(), '');
    await reset('/@writer/post/EXACT', '<main><header><a href="/@writer/post/EXACT">Header permalink</a></header>' +
      '<article id="svg-card"><a href="/@writer/post/EXACT">Root</a><a href="/insights/post/EXACT">Insights</a>' +
      '<div role="button" id="svg-like"><svg role="img" title="收回讚"><title>收回讚</title></svg><span>193</span></div>' +
      '<div role="button" id="svg-repost" aria-haspopup="dialog"><svg role="img" title="轉發"><title>轉發</title></svg><span>3</span></div></article></main>');
    const observedSvg = await page.evaluate(request => (window as any).SocialFixture.socialInspect(request), request);
    assert.equal(observedSvg.state, 'unlike'); assert.equal(observedSvg.verified, true);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    assert.equal(prepared.noop, true);
    await page.evaluate(() => {
      document.getElementById('svg-repost')!.onclick = () => {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.innerHTML = '<button>轉發</button>'; document.body.append(dialog);
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), { ...request, kind: 'repost' });
    assert.equal(prepared.noop, false);
    await page.locator('[role=dialog]').evaluate(el => el.remove());
    // Child <title> works without a title attribute, but conflicting labels do not.
    await page.locator('#svg-like svg').evaluate(el => el.removeAttribute('title'));
    assert.equal((await page.evaluate(request => (window as any).SocialFixture.socialInspect(request), request)).state, 'unlike');
    await page.locator('#svg-like svg').evaluate(el => el.setAttribute('title', 'Delete'));
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), request), /AMBIGUOUS_UI/);
    await page.locator('#svg-like svg').evaluate(el => el.setAttribute('title', '收回讚'));
    await page.locator('#svg-like').evaluate(el => el.insertAdjacentHTML('beforeend', '<svg role="img" title="Delete"><title>Delete</title></svg>'));
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), request), /AMBIGUOUS_UI/);
    await reset('/@writer/post/EXACT', card);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    await page.locator('article a').evaluate(el => el.setAttribute('href', '/@writer/post/OTHER'));
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /AMBIGUOUS_UI|TARGET_CHANGED/);
    assert.equal(await page.evaluate(() => (window as any).clicks || 0), 0);
    await reset('/@writer/post/EXACT', card + card);
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), request), /AMBIGUOUS_UI/);
    await reset('/@writer/post/EXACT', card.replace('</article>', '<button aria-label="More" aria-haspopup="menu" id="more">More</button></article>'));
    await page.evaluate(() => {
      document.getElementById('more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
        const button = document.createElement('button'); button.textContent = (window as any).saved ? 'Unsave' : 'Save';
        button.onclick = () => { (window as any).saved = !(window as any).saved; menu.remove(); };
        menu.append(button); document.body.append(menu);
      };
    });
    const save = { ...request, kind: 'save' };
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), save);
    assert.equal(await page.evaluate(() => (window as any).saved), undefined);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal((await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: save, token: prepared.token })).verified, true);
    await reset('/@writer', '<header><a href="/@writer">writer</a><button aria-label="Follow" onclick="this.setAttribute(\'aria-label\',\'Following\')">Follow</button></header>');
    const follow = { kind: 'follow', targetUrl: 'https://www.threads.com/@writer' };
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), follow);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal((await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: follow, token: prepared.token })).verified, true);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), { ...follow, kind: 'unfollow' });
    assert.equal(prepared.noop, false); // Following is only dispatched during explicit execution.
    const profileRegion = '<div role="region" aria-label="直欄內文"><div><h1>Writer Name</h1><span>writer</span></div>' +
      '<div role="button" id="profile-follow">追蹤中</div><div role="button">發送訊息</div><div>' +
      '<a href="/@writer" aria-current="page" aria-label="串文">串文</a><a href="/@writer/replies">回覆</a><a href="/@writer/media">影音內容</a><a href="/@writer/reposts">轉發</a></div>' +
      '<div data-pagelet="threads_profile_posts_timeline_0"><article><a href="/@writer/post/ITEM">Post</a><button id="post-follow">追蹤</button></article></div></div>' +
      '<aside><h1>Suggested</h1><a href="/@writer">writer</a><button id="suggested-follow">追蹤</button></aside>';
    await reset('/@writer', profileRegion);
    assert.equal((await page.evaluate(request => (window as any).SocialFixture.socialInspect(request), follow)).state, 'unfollow');
    await reset('/@writer', '<main><a href="/@writer" aria-label="直欄標題"><h1><span>writer</span></h1></a>' + profileRegion + '</main>');
    assert.equal((await page.evaluate(request => (window as any).SocialFixture.socialInspect(request), follow)).state, 'unfollow');
    await reset('/@writer', '<main>' + profileRegion + profileRegion + '</main>');
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialInspect(request), follow), /AMBIGUOUS_UI_PROFILE_SCOPE/);
    await reset('/@writer', profileRegion);
    await page.evaluate(() => { document.getElementById('profile-follow')!.onclick = () => { document.getElementById('profile-follow')!.textContent = '追蹤'; (window as any).unfollowClicks = 1; }; });
    const unfollow = { ...follow, kind: 'unfollow' };
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), unfollow);
    assert.equal(await page.evaluate(() => (window as any).unfollowClicks), undefined);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal((await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: unfollow, token: prepared.token })).verified, true);
    assert.equal(await page.locator('#post-follow').innerText(), '追蹤');
    assert.equal(await page.locator('#suggested-follow').innerText(), '追蹤');
    await reset('/@writer', profileRegion);
    await page.evaluate(() => { document.getElementById('profile-follow')!.onclick = () => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = '<p>writer</p><button id="confirm-unfollow">取消追蹤</button>'; document.body.append(d); }; });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), unfollow);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    const confirmation = await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: unfollow, token: prepared.token });
    assert.equal(confirmation.state, 'confirmation-required'); assert.equal(confirmation.verified, false);
    assert.equal(await page.locator('#confirm-unfollow').count(), 1);
    await reset('/@writer', profileRegion.replace('<div role="button">發送訊息</div>', '<div role="button">追蹤</div>'));
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), follow), /AMBIGUOUS_UI/);
    const ownDelete = { kind: 'delete', targetUrl: 'https://www.threads.com/@fixture/post/OWN' };
    const ownCard = '<article id="own-card"><a href="/@fixture">fixture</a><a href="/@fixture/post/OWN">Own post</a><p>Exact own post</p><button aria-label="Like">Like</button><button id="own-more" aria-haspopup="menu">更多</button></article>';
    await reset('/@fixture/post/OWN', ownCard.replace('<article id="own-card">', '<article id="own-card" aria-busy="true">'));
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => {
        (window as any).busyRootClicks = ((window as any).busyRootClicks || 0) + 1;
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem">刪除</div>'; document.body.append(menu);
      };
      setTimeout(() => {
        (window as any).clicksWhileRootBusy = (window as any).busyRootClicks || 0;
        document.getElementById('own-card')!.setAttribute('aria-busy', 'false');
      }, 900); // Longer than the quiet interval, so descendants-only detection would click too early.
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    assert.equal(await page.evaluate(() => (window as any).clicksWhileRootBusy), 0);
    assert.equal(await page.evaluate(() => (window as any).busyRootClicks), 1);
    assert.equal(prepared.before.state, 'delete');
    await reset('/@fixture/post/OWN', ownCard.replace('<article id="own-card">', '<article id="own-card" aria-busy="true">'));
    await page.evaluate(() => { document.getElementById('own-more')!.onclick = () => { (window as any).busyRootClicks = ((window as any).busyRootClicks || 0) + 1; }; });
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete), /UI_NOT_READY_MENU_TARGET/);
    assert.equal(await page.evaluate(() => (window as any).busyRootClicks || 0), 0);
    await page.evaluate(request => {
      (window as any).preClickStage = (window as any).SocialFixture.socialStage(request).then(() => 'unexpected-success', (error: unknown) => String(error));
    }, ownDelete);
    await page.keyboard.press('Escape');
    assert.match(await page.evaluate(() => (window as any).preClickStage), /ACTION_CANCELLED/);
    assert.equal(await page.evaluate(() => (window as any).busyRootClicks || 0), 0);
    await reset('/@fixture/post/OWN', ownCard);
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => { (window as any).staleMoreClicks = ((window as any).staleMoreClicks || 0) + 1; };
      setTimeout(() => {
        const initial = document.getElementById('own-card')!;
        const replacement = initial.cloneNode(true) as HTMLElement; initial.replaceWith(replacement);
        (window as any).cardSettledAt = Date.now();
        replacement.querySelector<HTMLElement>('#own-more')!.onclick = () => {
          (window as any).settledMoreClicks = ((window as any).settledMoreClicks || 0) + 1;
          (window as any).clickedAfterQuietMs = Date.now() - (window as any).cardSettledAt;
          const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem" id="settled-delete">刪除</div>'; document.body.append(menu);
          document.getElementById('settled-delete')!.onclick = () => { (window as any).settledDeleteClicks = ((window as any).settledDeleteClicks || 0) + 1; };
        };
        setTimeout(() => { replacement.querySelector('p')!.textContent = 'Exact own post'; (window as any).cardSettledAt = Date.now(); }, 100);
      }, 150);
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    assert.equal(await page.evaluate(() => (window as any).staleMoreClicks || 0), 0);
    assert.equal(await page.evaluate(() => (window as any).settledMoreClicks), 1);
    assert.ok(await page.evaluate(() => (window as any).clickedAfterQuietMs >= 590));
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    assert.equal(await page.evaluate(() => (window as any).settledDeleteClicks), 1); // Commit binds the settled replacement card.
    await reset('/@fixture/post/OWN', ownCard);
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.style.minHeight = '20px'; document.body.append(menu);
        setTimeout(() => { const populated = document.createElement('div'); populated.setAttribute('role', 'menu'); populated.innerHTML = '<div role="menuitem">刪除</div>'; menu.replaceWith(populated); }, 200);
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    assert.equal(prepared.before.state, 'delete'); assert.equal(prepared.noop, false);
    await reset('/@fixture/post/OWN', ownCard + '<button id="manual-menu">Open another post menu</button>');
    await page.evaluate(() => {
      document.addEventListener('pointerdown', event => { (window as any).trustedPointer = event.isTrusted; }, true);
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.id = 'pending-menu'; menu.setAttribute('role', 'menu'); menu.style.minHeight = '20px'; document.body.append(menu);
      };
      document.getElementById('manual-menu')!.onclick = () => {
        document.querySelectorAll('[role="menu"]').forEach(el => el.remove());
        const foreign = document.createElement('div'); foreign.setAttribute('role', 'menu'); foreign.innerHTML = '<div role="menuitem" id="foreign-delete">刪除</div>'; document.body.append(foreign);
        document.getElementById('foreign-delete')!.onclick = () => { (window as any).foreignDeletes = ((window as any).foreignDeletes || 0) + 1; };
      };
    });
    await page.evaluate(request => {
      (window as any).pendingStage = (window as any).SocialFixture.socialStage(request).then(() => 'unexpected-success', (error: unknown) => String(error));
    }, ownDelete);
    await page.locator('#pending-menu').waitFor({ state: 'visible' });
    await page.locator('#manual-menu').click(); // Browser-generated trusted pointer events.
    assert.equal(await page.evaluate(() => (window as any).trustedPointer), true);
    assert.match(await page.evaluate(() => (window as any).pendingStage), /ACTION_CANCELLED/);
    assert.equal(await page.evaluate(() => (window as any).foreignDeletes || 0), 0);
    await page.evaluate(() => {
      document.querySelectorAll('[role="menu"]').forEach(el => el.remove());
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem">刪除</div>'; document.body.append(menu);
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    await page.locator('#manual-menu').click();
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /INVALID_ACTION/);
    assert.equal(await page.evaluate(() => (window as any).foreignDeletes || 0), 0);
    await reset('/@writer/post/EXACT', card);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), request);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    await page.keyboard.press('Escape'); // Trusted takeover invalidates commit-attributed verification too.
    await assert.rejects(page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request, token: prepared.token }), /ACTION_CANCELLED/);
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    await reset('/@fixture/post/OWN', ownCard);
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem">刪除</div>'; document.body.append(menu);
        document.getElementById('own-card')!.replaceWith(document.getElementById('own-card')!.cloneNode(true));
      };
    });
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete), /TARGET_CHANGED_MENU_CARD/);
    await reset('/@fixture/post/OWN', ownCard);
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem" id="delete-choice">刪除</div>'; document.body.append(menu);
        document.getElementById('delete-choice')!.onclick = () => {
          (window as any).deleteChoiceClicks = ((window as any).deleteChoiceClicks || 0) + 1;
          menu.remove(); const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.innerHTML = '<p>Delete this post?</p><button id="final-delete">Delete</button>'; document.body.append(dialog);
        };
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    assert.equal(await page.evaluate(() => (window as any).deleteChoiceClicks), undefined);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    const deletionConfirmation = await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: ownDelete, token: prepared.token });
    assert.equal(deletionConfirmation.state, 'confirmation-required'); assert.equal(deletionConfirmation.verified, false);
    assert.equal(await page.locator('#final-delete').count(), 1);
    assert.equal(await page.evaluate(() => (window as any).deleteChoiceClicks), 1);
    await reset('/@fixture/post/OWN', ownCard);
    await page.evaluate(() => {
      document.getElementById('own-more')!.onclick = () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem" id="delete-choice">刪除</div>'; document.body.append(menu);
        document.getElementById('delete-choice')!.onclick = () => { document.getElementById('own-card')!.remove(); menu.remove(); };
      };
    });
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    const disappeared = await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: ownDelete, token: prepared.token });
    assert.equal(disappeared.state, 'deletion-unverified'); assert.equal(disappeared.verified, false);
    await reset('/@writer/post/EXACT', card);
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), { ...request, kind: 'delete' }), /OWN_POST_REQUIRED/);
    assert.equal(await page.locator('[role=menu]').count(), 0);
    await reset('/@fixture/post/OWN', ownCard.replace('<a href="/@fixture">fixture</a>', '<a href="/@other">other</a>'));
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), ownDelete), /OWN_POST_REQUIRED/);
    await reset('/', '<button id="create">Create</button>');
    await page.evaluate(() => {
      document.getElementById('create')!.onclick = () => {
        const dialog = document.createElement('div'); dialog.setAttribute('role','dialog');
        dialog.innerHTML = '<textarea aria-label="Write"></textarea><button id="submit">Post</button>';
        document.body.append(dialog);
        document.getElementById('submit')!.onclick = () => {
          const text = dialog.querySelector('textarea')!.value;
          dialog.remove(); const post = document.createElement('article');
          post.innerHTML = '<a href="/@fixture/post/NEW">New</a><p></p><time></time><button aria-label="Like">Like</button>';
          post.querySelector('time')!.setAttribute('datetime', new Date().toISOString());
          post.querySelector('p')!.textContent = text; document.body.append(post);
          history.pushState({}, '', '/@fixture/post/NEW');
          (window as any).published = true;
        };
      };
    });
    const publish = { kind: 'publish', targetUrl: 'https://www.threads.com/', text: 'exact approved text' };
    assert.equal((await page.evaluate(request => (window as any).SocialFixture.socialInspect(request), { kind: 'publish', targetUrl: publish.targetUrl })).verified, false);
    assert.equal(await page.locator('[role=dialog]').count(), 0);
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), publish);
    assert.equal(await page.locator('textarea').inputValue(), publish.text);
    assert.equal(await page.evaluate(() => (window as any).published), undefined);
    await page.locator('textarea').fill('manual takeover');
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /INVALID_ACTION/);
    assert.equal(await page.evaluate(() => (window as any).published), undefined);
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialStage(request), publish), /EXISTING_DRAFT/);
    await page.locator('[role=dialog]').evaluate(el => el.remove());
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), publish);
    await page.locator('textarea').evaluate(el => { (el as HTMLTextAreaElement).value = 'script-modified draft'; });
    await assert.rejects(page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token), /DRAFT_CHANGED/);
    await page.locator('[role=dialog]').evaluate(el => el.remove());
    prepared = await page.evaluate(request => (window as any).SocialFixture.socialStage(request), publish);
    await page.evaluate(token => (window as any).SocialFixture.socialCommit(token, 'fixture'), prepared.token);
    const published = await page.evaluate(({ request, token }) => (window as any).SocialFixture.socialInspect(request, token), { request: publish, token: prepared.token });
    assert.equal(published.verified, true); assert.equal(published.postUrl, 'https://www.threads.com/@fixture/post/NEW');
    await assert.rejects(page.evaluate(request => (window as any).SocialFixture.socialInspect(request), publish), /TARGET_CHANGED/);
  } finally { await browser.close(); }
});
