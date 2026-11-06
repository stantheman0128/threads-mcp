import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';

const target = 'https://www.threads.com/@author/post/Source1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const manifest = { name: 'fixture.png', mime: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
const html = `<!doctype html><html><body>
<a id="account" href="/@fixture" aria-label="Profile">Profile</a>
<button id="create" onclick="openComposer('publish')">Create</button>
<article id="post"><a href="/@author">author</a><a href="/@author/post/Source1"><time datetime="2026-11-06T00:00:00Z">Today</time></a><p>Complete original source body</p>
<button>Like</button><button onclick="openComposer('reply')">Reply</button><button aria-haspopup="menu" onclick="openQuoteMenu()">Repost</button></article>
<script>
window.published=0;window.openClicks=0;
window.openQuoteMenu=()=>{const menu=document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button>Quote</button>';menu.querySelector('button').onclick=()=>{menu.remove();openComposer('quote')};document.body.append(menu)};
window.openComposer=kind=>{
  window.openClicks++;
  const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.id='composer';
  const source=kind==='publish'?'':kind==='reply'?'<section id="source"><a href="/@author">author</a><time datetime="2026-11-06T00:00:00Z">Today</time><p>Complete original source body</p></section>':'<section id="source"><a href="/@author/post/Source1">Quoted source</a></section>';
  dialog.innerHTML='<h2>'+(kind==='reply'?'Reply':'New thread')+'</h2>'+source+'<div data-barcelona-composer-body="true"><textarea style="width:200px;height:40px"></textarea><input type="file" accept="image/*" multiple><div id="previews"></div></div><button id="publish">Post</button>';
  dialog.querySelector('input').onchange=event=>{const previews=dialog.querySelector('#previews');previews.replaceChildren();for(const file of event.target.files){const image=document.createElement('img');image.src=URL.createObjectURL(file);image.width=20;image.height=20;previews.append(image)}};
  dialog.querySelector('#publish').onclick=()=>{window.published++};document.body.append(dialog);
};
</script></body></html>`;
const call = (page: Page, command: Record<string, unknown>) => page.evaluate(command => (window as any).Fixture.media(command), command);
const stage = (page: Page, kind: string, mediaToken: string) => page.evaluate(({ kind, mediaToken, target }) =>
  (window as any).Fixture.socialStage({ kind, targetUrl: kind === 'publish' ? 'https://www.threads.com/' : target, text: 'Prepared fixture text', mediaToken }), { kind, mediaToken, target });
async function begin(page: Page, kind: string) {
  return call(page, { operation: 'begin', expectedAccount: 'fixture', files: [manifest], compose: { kind, targetUrl: kind === 'publish' ? 'https://www.threads.com/' : target } });
}
async function upload(page: Page, kind: string) {
  const transfer = await begin(page, kind);
  await call(page, { operation: 'chunk', uploadId: transfer.uploadId, fileIndex: 0, offset: 0, data: png.toString('base64') });
  const result = await call(page, { operation: 'finish', uploadId: transfer.uploadId });
  assert.equal(result.published, false);
  assert.equal(await page.locator('textarea').inputValue(), '');
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('#previews img')].every(image => image.complete && image.naturalWidth > 0));
  const bytes = await page.evaluate(async () => [...new Uint8Array(await document.querySelector<HTMLInputElement>('input[type=file]')!.files![0]!.arrayBuffer())]);
  assert.deepEqual(Buffer.from(bytes), png);
  return result.mediaToken as string;
}

test('remote media composer and commit acceptance in isolated Chrome', { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async t => {
  const bundle = await build({ stdin: { contents: `export {media,cancelMediaTransfers} from './src/media-runtime.ts'; export {socialStage,socialCommit} from './src/social-runtime.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Fixture', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().resourceType() === 'document' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  const fresh = async (kind = 'publish') => {
    const page = await context.newPage();
    await page.goto(kind === 'publish' ? 'https://www.threads.com/' : target);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    return page;
  };
  try {
    for (const kind of ['publish', 'reply', 'quote']) await t.test(`${kind}: bytes → preview → prepared text → one commit`, async () => {
      const page = await fresh(kind);
      try {
        const token = await upload(page, kind);
        assert.equal(await page.evaluate(() => (window as any).published), 0);
        const prepared = await stage(page, kind, token);
        assert.equal(await page.locator('textarea').inputValue(), 'Prepared fixture text');
        assert.equal(await page.evaluate(() => (window as any).published), 0);
        const result = await page.evaluate(token => (window as any).Fixture.socialCommit(token, 'fixture'), prepared.token);
        assert.equal(result.dispatched, true);
        assert.equal(await page.evaluate(() => (window as any).published), 1);
        await assert.rejects(page.evaluate(token => (window as any).Fixture.socialCommit(token, 'fixture'), prepared.token), /INVALID_ACTION/);
        assert.equal(await page.evaluate(() => (window as any).published), 1);
      } finally { await page.close(); }
    });
    await t.test('invalid manifest, wrong account and existing draft never open a composer', async () => {
      const page = await fresh();
      try {
        const base = { operation: 'begin', expectedAccount: 'fixture', files: [manifest], compose: { kind: 'publish', targetUrl: 'https://www.threads.com/' } };
        await assert.rejects(call(page, { ...base, files: [{ ...manifest, size: 9 * 1024 * 1024 }] }), /INVALID_MEDIA/);
        await assert.rejects(call(page, { ...base, expectedAccount: 'wrong' }), /ACCOUNT_MISMATCH/);
        await page.evaluate(() => { const editor = document.createElement('textarea'); editor.value = 'existing manual draft'; document.body.append(editor); });
        await assert.rejects(call(page, base), /EXISTING_DRAFT/);
        assert.equal(await page.locator('textarea').inputValue(), 'existing manual draft');
        await page.evaluate(() => {
          document.querySelector('textarea')!.value = '';
          const input = document.createElement('input'); input.type = 'file';
          const files = new DataTransfer(); files.items.add(new File(['existing'], 'manual.png', { type: 'image/png' }));
          input.files = files.files; document.body.append(input);
        });
        await assert.rejects(call(page, base), /EXISTING_DRAFT/);
        assert.equal(await page.locator('input[type=file]').evaluate((el: HTMLInputElement) => el.files!.length), 1);
        assert.equal(await page.evaluate(() => (window as any).openClicks), 0);
      } finally { await page.close(); }
    });
    await t.test('wrong reply route does not click, and changed source preview blocks transfer', async () => {
      const page = await fresh('reply');
      try {
        await assert.rejects(call(page, { operation: 'begin', expectedAccount: 'fixture', files: [manifest], compose: { kind: 'reply', targetUrl: target.replace('Source1', 'Different') } }), /TARGET_CHANGED_ROUTE/);
        assert.equal(await page.evaluate(() => (window as any).openClicks), 0);
        const transfer = await begin(page, 'reply');
        await page.evaluate(() => { document.querySelector('#source p')!.textContent = 'Changed source'; });
        await assert.rejects(call(page, { operation: 'chunk', uploadId: transfer.uploadId, fileIndex: 0, offset: 0, data: png.toString('base64') }), /TARGET_CHANGED/);
        assert.equal(await page.evaluate(() => (window as any).published), 0);
      } finally { await page.close(); }
    });
    for (const change of ['draft', 'account', 'target', 'attachment', 'manual']) await t.test(`${change} change prevents commit`, async () => {
      const page = await fresh('reply');
      try {
        const token = await upload(page, 'reply');
        const prepared = await stage(page, 'reply', token);
        if (change === 'manual') await page.locator('textarea').press('ArrowLeft');
        else await page.evaluate(change => {
          if (change === 'draft') document.querySelector('textarea')!.value = 'Changed draft';
          if (change === 'account') document.querySelector('#account')!.setAttribute('href', '/@different');
          if (change === 'target') document.querySelector('#source p')!.textContent = 'Changed target';
          if (change === 'attachment') document.querySelector<HTMLInputElement>('input[type=file]')!.files = new DataTransfer().files;
        }, change);
        await assert.rejects(page.evaluate(token => (window as any).Fixture.socialCommit(token, 'fixture'), prepared.token), /DRAFT_CHANGED|ACCOUNT_MISMATCH|TARGET_CHANGED|MEDIA_APPROVAL_STALE|INVALID_ACTION/);
        assert.equal(await page.evaluate(() => (window as any).published), 0);
      } finally { await page.close(); }
    });
    await t.test('manual takeover before staging invalidates media even when contents are unchanged', async () => {
      const page = await fresh();
      try {
        const token = await upload(page, 'publish');
        await page.locator('textarea').press('ArrowLeft');
        await assert.rejects(stage(page, 'publish', token), /MEDIA_APPROVAL_STALE/);
        assert.equal(await page.locator('textarea').inputValue(), '');
        assert.equal(await page.evaluate(() => (window as any).published), 0);
      } finally { await page.close(); }
    });
  } finally { await context.close(); await browser.close(); }
});
