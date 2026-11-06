import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { MediaController, mediaMime, MEDIA_CHUNK_BYTES } from '../src/media.js';

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(70_000)]);
test('media signatures reject unsupported formats and extension mismatch', () => {
  assert.equal(mediaMime(png, '.PNG'), 'image/png');
  assert.throws(() => mediaMime(png, '.jpg'), /signature|mismatch/);
  assert.throws(() => mediaMime(Buffer.from('<html>'), '.png'), /signature|mismatch/);
  assert.equal(mediaMime(Buffer.from('0000ftypisom'), '.mp4'), 'video/mp4');
  assert.throws(() => mediaMime(Buffer.from('0000ftypavif'), '.mp4'), /signature|mismatch/);
});

test('media controller guards writes, alt text and local input before dispatch', async () => {
  let calls = 0;
  const command = async <T>(): Promise<T> => { calls++; return {} as T; };
  await assert.rejects(new MediaController({ writesEnabled: false, command }).uploadFiles([], 'fixture'), /Enable writes/);
  const controller = new MediaController({ writesEnabled: true, command });
  await assert.rejects(controller.uploadFiles(['relative.png'], 'fixture'), /absolute local/);
  await assert.rejects(controller.uploadFiles(['relative.png'], 'fixture', ['description']), /alt text/);
  assert.equal(calls, 0);
});

test('media controller bounded chunks reconstruct files and does not replay uncertain finish', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threads-media-test-'));
  try {
    const file = join(directory, 'photo.png');
    await writeFile(file, png);
    const commands: Record<string, unknown>[] = [];
    const command = async <T>(value: Record<string, unknown>): Promise<T> => {
      commands.push(value);
      if (value.operation === 'begin') return { uploadId: 'test-transfer' } as T;
      if (value.operation === 'finish') throw new Error('BRIDGE_TIMEOUT');
      return {} as T;
    };
    const controller = new MediaController({ writesEnabled: true, command });
    await assert.rejects(controller.uploadFiles([file], 'fixture'), /BRIDGE_TIMEOUT/);
    assert.deepEqual(commands.map(value => value.operation), ['begin', 'chunk', 'chunk', 'chunk', 'finish']);
    assert.ok(commands.every(value => Buffer.byteLength(JSON.stringify(value)) < 64 * 1024));
    const chunks = commands.filter(value => value.operation === 'chunk');
    assert.deepEqual(chunks.map(value => value.offset), [0, MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES * 2]);
    assert.deepEqual(Buffer.concat(chunks.map(value => Buffer.from(value.data as string, 'base64'))), png);
    assert.equal((commands[0]!.files as any[])[0].sha256, createHash('sha256').update(png).digest('hex'));
    commands.length = 0;
    await assert.rejects(new MediaController({ writesEnabled: true, command, maxImageBytes: 10 }).uploadFiles([file], 'fixture'), /per-file/);
    assert.equal(commands.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('media runtime binds account/composer, stages exact bytes and invalidates changed attachments', { skip: process.env.THREADS_BROWSER_TESTS !== 'true' }, async () => {
  const bundled = await build({ entryPoints: ['src/media-runtime.ts'], bundle: true, platform: 'browser', format: 'iife',
    globalName: 'MediaFixture', write: false, target: 'chrome120' });
  const browser = await chromium.launch({ channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><a href="/@fixture" aria-label="Profile">Profile</a>
      <div role="dialog"><section id="source-post"><img src="https://fixture.invalid/source.png" alt="Original post image"><video src="https://fixture.invalid/source.mp4"></video></section>
        <div data-barcelona-composer-body="true"><div role="textbox" contenteditable="true" style="width:200px;height:30px"></div><input type="file" accept="image/*" multiple></div>
        <button onclick="window.didPublish=true">Post</button></div>` }));
    const page = await context.newPage();
    await page.goto('https://www.threads.com/');
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    const call = (command: Record<string, unknown>) => page.evaluate(command => (window as any).MediaFixture.media(command), command);
    const manifest = { name: 'test.png', mime: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    await assert.rejects(call({ operation: 'begin', expectedAccount: 'wrong', files: [manifest] }), /ACCOUNT_MISMATCH/);
    await page.locator('[contenteditable]').fill('manual draft');
    await assert.rejects(call({ operation: 'begin', expectedAccount: 'fixture', files: [manifest] }), /MEDIA_DRAFT_EXISTS/);
    await page.locator('[contenteditable]').fill('');
    const first = await call({ operation: 'begin', expectedAccount: 'fixture', files: [manifest] });
    await assert.rejects(call({ operation: 'chunk', uploadId: first.uploadId, fileIndex: 0, offset: 1, data: png.subarray(0, 8).toString('base64') }), /INVALID_MEDIA_CHUNK/);
    await page.locator('[contenteditable]').fill('manual takeover');
    await assert.rejects(call({ operation: 'chunk', uploadId: first.uploadId, fileIndex: 0, offset: 0, data: png.subarray(0, 8).toString('base64') }), /MEDIA_COMPOSER_CHANGED/);
    await call({ operation: 'abort', uploadId: first.uploadId });
    assert.equal(await page.locator('[contenteditable]').innerText(), 'manual takeover');
    await page.locator('[contenteditable]').fill('');
    const begun = await call({ operation: 'begin', expectedAccount: 'fixture', files: [manifest] });
    for (let offset = 0; offset < png.length; offset += MEDIA_CHUNK_BYTES)
      await call({ operation: 'chunk', uploadId: begun.uploadId, fileIndex: 0, offset, data: png.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64') });
    const result = await call({ operation: 'finish', uploadId: begun.uploadId });
    assert.equal(result.status, 'staged');
    assert.equal(result.published, false);
    assert.equal(result.previewReady, null);
    assert.equal(await page.evaluate(() => (window as any).didPublish), undefined);
    assert.equal(await page.evaluate(async () => {
      const file = document.querySelector('input')!.files![0]!;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
    }), manifest.sha256);
    await assert.rejects(call({ operation: 'finish', uploadId: begun.uploadId }), /MEDIA_TRANSFER_MISSING/);
    const approve = () => page.evaluate(token => (window as any).MediaFixture.assertApprovedMedia(token, document.querySelector('[role="dialog"]')), result.mediaToken);
    await assert.rejects(approve(), /MEDIA_PREVIEW_UNVERIFIED/);
    await page.evaluate(() => {
      const image = document.createElement('img'); image.src = URL.createObjectURL(document.querySelector('input')!.files![0]!); image.width = 100; image.height = 100;
      document.querySelector('[data-barcelona-composer-body]')!.append(image);
    });
    await page.evaluate(() => {
      const extra = document.querySelector('[data-barcelona-composer-body] img')!.cloneNode(true) as HTMLElement;
      extra.id = 'unexpected-attachment';
      document.querySelector('[data-barcelona-composer-body]')!.append(extra);
    });
    await assert.rejects(approve(), /MEDIA_PREVIEW_UNVERIFIED/);
    await page.evaluate(() => document.getElementById('unexpected-attachment')!.remove());
    await approve();
    await page.locator('[contenteditable]').fill('explicitly prepared social text');
    await approve();
    await page.evaluate(() => { document.querySelector('input')!.files = new DataTransfer().files; });
    await assert.rejects(approve(), /MEDIA_APPROVAL_STALE/);
    // A fixed disconnect cancellation can arrive while finish is awaiting its hash.
    await page.locator('[contenteditable]').fill('');
    await page.evaluate(() => document.querySelector('[data-barcelona-composer-body] img')!.remove());
    const interrupted = await call({ operation: 'begin', expectedAccount: 'fixture', files: [manifest] });
    for (let offset = 0; offset < png.length; offset += MEDIA_CHUNK_BYTES)
      await call({ operation: 'chunk', uploadId: interrupted.uploadId, fileIndex: 0, offset, data: png.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64') });
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
        (window as any).digestStarted = true;
        await new Promise<void>(resolve => { (window as any).releaseDigest = resolve; });
        return original(...args);
      };
    });
    const finishing = call({ operation: 'finish', uploadId: interrupted.uploadId });
    const cancelled = assert.rejects(finishing, /MEDIA_CANCELLED/);
    await page.waitForFunction(() => (window as any).digestStarted);
    await page.evaluate(() => { (window as any).MediaFixture.cancelMediaTransfers(); (window as any).releaseDigest(); });
    await cancelled;
    assert.equal(await page.evaluate(() => document.querySelector('input')!.files!.length), 0);
    assert.equal(await page.evaluate(() => (window as any).didPublish), undefined);
  } finally { await browser.close(); }
});
