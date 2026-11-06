import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RemoteMediaController } from '../src/remote-media.js';
import type { BrowserDriver } from '../src/driver.js';
import type { ThreadsService } from '../src/service.js';
import { ThreadsError } from '../src/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const file = { name: 'original.png', mime: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
const targetUrl = 'https://www.threads.com/';
const expectedAccount = 'fixture';
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof ThreadsError && error.code === code);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'threads-remote-media-'));
  const commands: Record<string, unknown>[] = [];
  const bytes: Buffer[] = [];
  let account = expectedAccount, draft = false, runtime = 1, denied = false, uncertain = false;
  let onCommand: ((command: Record<string, unknown>) => Promise<void>) | undefined;
  const raw = { command: async <T>(command: Record<string, unknown>): Promise<T> => {
    commands.push(command); await onCommand?.(command);
    if (command.type === 'read') return { url: targetUrl, remoteMediaVersion: runtime, viewer: { username: account }, composerState: { present: draft, nonempty: draft, attachments: false, ambiguous: false } } as T;
    if (command.type === 'media') {
      if (command.operation === 'begin') return { uploadId: randomUUID() } as T;
      if (command.operation === 'chunk') { bytes.push(Buffer.from(command.data as string, 'base64')); return {} as T; }
      if (command.operation === 'finish') {
        if (uncertain) throw new ThreadsError('BRIDGE_TIMEOUT', 'private host path');
        return { status: 'staged', mediaToken: randomUUID(), fileCount: 1, files: ['generated.png'], published: false, previewReady: null, warning: 'fixture' } as T;
      }
      if (command.operation === 'abort') return {} as T;
    }
    throw new Error('Unexpected browser command');
  } } as BrowserDriver;
  const service = { config: { dataDir: dir, writesEnabled: true }, serial: async <T>(run: () => Promise<T>) => run() } as ThreadsService;
  const access = () => { if (denied) throw new ThreadsError('REMOTE_WRITE_REVOKED', 'private credential'); };
  let controller = new RemoteMediaController(service, raw, access);
  const receipts = () => readdirSync(join(dir, 'remote-media', 'receipts')).filter(name => name.endsWith('.json')).map(name => join(dir, 'remote-media', 'receipts', name));
  const folders = () => readdirSync(join(dir, 'remote-media', 'quarantine'));
  return { dir, commands, bytes, receipts, folders, get controller() { return controller; },
    account: (value: string) => { account = value; }, draft: () => { draft = true; }, runtime: () => { runtime = 0; }, deny: () => { denied = true; }, uncertain: () => { uncertain = true; },
    hook: (value: typeof onCommand) => { onCommand = value; },
    restart: (status?: string) => {
      controller.close();
      if (status) for (const path of receipts()) { const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.status = status; writeFileSync(path, JSON.stringify(receipt)); }
      controller = new RemoteMediaController(service, raw, access);
    },
    close: () => { controller.close(); assert.equal(dirname(dir), tmpdir()); rmSync(dir, { recursive: true, force: true }); },
  };
}
async function begin(f: ReturnType<typeof fixture>, metadata = file) {
  const uploadId = randomUUID();
  const call = (operation: string, more: object = {}) => f.controller.handle({ operation, uploadId, expectedAccount, ...more }) as Promise<any>;
  await call('begin', { kind: 'publish', targetUrl, files: [metadata] });
  return { uploadId, call };
}
async function upload(f: ReturnType<typeof fixture>) {
  const u = await begin(f); await u.call('chunk', { fileIndex: 0, offset: 0, data: png.toString('base64') }); return u;
}

test('remote media exact bytes, top-level receipt and bound approval survive status, never replay finish', async () => {
  const f = fixture(); try {
    const u = await upload(f); const result = await u.call('finish');
    assert.equal(result.status, 'staged'); assert.equal(result.published, false); assert.equal(result.previewReady, null); assert.equal(result.fileCount, 1);
    assert.deepEqual(result.files, [{ name: file.name, mime: file.mime, size: file.size, received: file.size }]);
    assert.deepEqual(Buffer.concat(f.bytes), png); assert.deepEqual(await u.call('status'), result);
    assert.equal(f.folders().length, 0);
    assert.doesNotMatch(JSON.stringify(result), /quarantine|storageId|internalName|generated\.png/);
    const request = { kind: 'publish' as const, targetUrl, text: 'Approved caption', mediaToken: result.mediaToken };
    assert.doesNotThrow(() => f.controller.authorize(request, expectedAccount));
    assert.throws(() => f.controller.authorize(request, 'another'), /Remote media approval/);
    assert.throws(() => f.controller.authorize({ ...request, kind: 'reply', targetUrl: 'https://www.threads.com/@fixture/post/test' }, expectedAccount), /Remote media approval/);
    await rejects(u.call('finish'), 'UPLOAD_FINISH_CONSUMED');
    assert.equal(f.commands.filter(command => command.operation === 'finish').length, 1);
  } finally { f.close(); }
});

test('remote media rejects local/URL paths, unsafe names, types, oversized manifests and unknown fields before browser access', async () => {
  const f = fixture(); try {
    const base = { operation: 'begin', uploadId: randomUUID(), expectedAccount, kind: 'publish', targetUrl, files: [file] };
    for (const name of ['../secret.png', 'C:\\secret.png', 'https://example.com/a.png', 'CON.png', 'trailing.png ', 'path/inside.png'])
      await rejects(f.controller.handle({ ...base, files: [{ ...file, name }] }), 'INVALID_MEDIA_NAME');
    await rejects(f.controller.handle({ ...base, paths: ['C:\\secret.png'] }), 'INVALID_MEDIA');
    await rejects(f.controller.handle({ ...base, files: [{ ...file, mime: 'text/html' }] }), 'MEDIA_TYPE_MISMATCH');
    await rejects(f.controller.handle({ ...base, files: [{ ...file, size: 8 * 1024 * 1024 + 1 }] }), 'MEDIA_SIZE_LIMIT');
    await rejects(f.controller.handle({ ...base, files: Array(21).fill(file) }), 'INVALID_MEDIA');
    await rejects(f.controller.handle({ ...base, files: Array(9).fill({ ...file, size: 8 * 1024 * 1024 }) }), 'MEDIA_SIZE_LIMIT');
    await rejects(f.controller.handle({ ...base, files: [{ name: 'video.mp4', mime: 'video/mp4', size: 64 * 1024 * 1024 + 1, sha256: file.sha256 }] }), 'MEDIA_SIZE_LIMIT');
    assert.equal(f.commands.length, 0); assert.equal(f.receipts().length, 0);
  } finally { f.close(); }
});

test('remote media strict offsets/chunks, unknown UUID and single active upload', async () => {
  const f = fixture(); try {
    await rejects(f.controller.handle({ operation: 'status', uploadId: randomUUID(), expectedAccount }), 'UPLOAD_NOT_FOUND');
    await rejects(f.controller.handle({ operation: 'status', uploadId: '../oops', expectedAccount }), 'INVALID_UPLOAD_ID');
    const u = await begin(f);
    await rejects(begin(f), 'MEDIA_BUSY');
    await rejects(u.call('status', { expectedAccount: 'another' }), 'ACCOUNT_MISMATCH');
    await rejects(u.call('chunk', { fileIndex: 0, offset: 1, data: png.toString('base64') }), 'MEDIA_OFFSET_MISMATCH');
    for (const data of ['!!!!', 'AAAA\n', Buffer.alloc(32769).toString('base64')])
      await rejects(u.call('chunk', { fileIndex: 0, offset: 0, data }), 'INVALID_MEDIA_CHUNK');
    await u.call('chunk', { fileIndex: 0, offset: 0, data: png.toString('base64') });
    await rejects(u.call('chunk', { fileIndex: 0, offset: 0, data: png.toString('base64') }), 'MEDIA_OFFSET_MISMATCH');
    assert.equal(f.commands.length, 0);
    await u.call('abort'); assert.equal(f.folders().length, 0);
  } finally { f.close(); }
});

test('remote media validates complete bytes and SHA before browser effects and consumes failed finish', async () => {
  for (const complete of [false, true]) {
    const f = fixture(); try {
      const u = await begin(f, { ...file, sha256: '0'.repeat(64) });
      if (complete) await u.call('chunk', { fileIndex: 0, offset: 0, data: png.toString('base64') });
      await rejects(u.call('finish'), complete ? 'MEDIA_HASH_MISMATCH' : 'MEDIA_INCOMPLETE');
      await rejects(u.call('finish'), 'UPLOAD_FINISH_CONSUMED');
      assert.equal((await u.call('status')).status, 'failed'); assert.equal(f.commands.length, 0); assert.equal(f.folders().length, 0);
    } finally { f.close(); }
  }
});

test('remote media rejects mismatched signature even when uploaded hash matches', async () => {
  const f = fixture(); try {
    const bytes = Buffer.from('not an image'); const u = await begin(f, { ...file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await u.call('chunk', { fileIndex: 0, offset: 0, data: bytes.toString('base64') });
    await rejects(u.call('finish'), 'MEDIA_TYPE_MISMATCH'); assert.equal(f.commands.length, 0);
  } finally { f.close(); }
});

test('remote media refuses drafts, wrong viewers and old runtimes before begin', async () => {
  for (const mode of ['draft', 'account', 'runtime']) {
    const f = fixture(); try {
      const u = await upload(f);
      if (mode === 'draft') f.draft(); else if (mode === 'account') f.account('another'); else f.runtime();
      await rejects(u.call('finish'), mode === 'draft' ? 'COMPOSER_BUSY' : mode === 'account' ? 'ACCOUNT_MISMATCH' : 'REMOTE_MEDIA_RUNTIME_REQUIRED');
      assert.equal(f.commands.filter(command => command.type === 'media').length, 0); assert.equal(f.folders().length, 0);
    } finally { f.close(); }
  }
});

test('remote media checks access after browser awaits and invalidates approved media', async () => {
  const f = fixture(); try {
    const u = await upload(f); f.hook(async command => { if (command.operation === 'chunk') f.deny(); });
    await rejects(u.call('finish'), 'REMOTE_WRITE_REVOKED');
    assert.equal(f.commands.filter(command => command.operation === 'finish').length, 0); assert.equal(f.folders().length, 0);
  } finally { f.close(); }
  const g = fixture(); try {
    const u = await upload(g); const result = await u.call('finish'); g.controller.invalidate();
    assert.throws(() => g.controller.authorize({ kind: 'publish', targetUrl, mediaToken: result.mediaToken }, expectedAccount), /approval/);
    assert.equal((await u.call('status')).status, 'revoked');
  } finally { g.close(); }
});

test('remote media uncertain finish is durable and never re-dispatched after restart', async () => {
  const f = fixture(); try {
    const u = await upload(f); f.uncertain();
    await rejects(u.call('finish'), 'BRIDGE_TIMEOUT');
    const status = await u.call('status'); assert.equal(status.status, 'outcome-uncertain'); assert.doesNotMatch(JSON.stringify(status), /private host path/);
    f.restart(); assert.equal((await u.call('status')).status, 'outcome-uncertain');
    await rejects(u.call('finish'), 'UPLOAD_FINISH_CONSUMED'); assert.equal(f.commands.filter(command => command.operation === 'finish').length, 1);
  } finally { f.close(); }
});

test('remote media persisted finishing is recovered as uncertain and receiving cannot resume on restart', async () => {
  for (const state of ['finishing', 'receiving']) {
    const f = fixture(); try {
      const u = await upload(f); f.restart(state);
      assert.equal((await u.call('status')).status, state === 'finishing' ? 'outcome-uncertain' : 'expired');
      await rejects(u.call('finish'), 'UPLOAD_FINISH_CONSUMED'); assert.equal(f.commands.length, 0); assert.equal(f.folders().length, 0);
    } finally { f.close(); }
  }
});

test('remote media expiry cleans receiving bytes and invalidates staged approvals', async t => {
  const f = fixture(); try {
    const u = await upload(f); const now = Date.now(); t.mock.method(Date, 'now', () => now + 300001);
    assert.equal((await u.call('status')).status, 'expired'); assert.equal(f.folders().length, 0);
    await rejects(u.call('finish'), 'UPLOAD_FINISH_CONSUMED'); t.mock.restoreAll();
    const v = await upload(f); const result = await v.call('finish'); t.mock.method(Date, 'now', () => Date.parse(result.expiresAt) + 1);
    assert.equal((await v.call('status')).status, 'expired');
    assert.throws(() => f.controller.authorize({ kind: 'publish', targetUrl, mediaToken: result.mediaToken }, expectedAccount), /approval/);
  } finally { t.mock.restoreAll(); f.close(); }
});
