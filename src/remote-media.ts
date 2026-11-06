import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserDriver } from './driver.js';
import { MediaController, mediaMime, type MediaFileManifest, type MediaStageResult } from './media.js';
import type { PageRead } from './page-runtime.js';
import { assertRemoteDraftSafe, assertRemoteViewer, checkedRemoteSocialArgs, remoteAccount } from './remote-social-driver.js';
import { sameThreadsRoute, type ThreadsService } from './service.js';
import type { SocialRequest } from './social-runtime.js';
import { ThreadsError } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL = 300_000;
const APPROVAL_TTL = 600_000;
const MAX_RECEIPTS = 1024;
const mimeExtensions: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/gif': ['.gif'], 'image/webp': ['.webp'],
  'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'], 'video/webm': ['.webm'],
};
type State = 'receiving' | 'finishing' | 'staged' | 'outcome-uncertain' | 'failed' | 'aborted' | 'expired' | 'revoked';
interface StoredFile extends MediaFileManifest { received: number; internalName: string; }
interface Receipt {
  version: 1; uploadId: string; storageId: string; expectedAccount: string; kind: 'publish' | 'reply' | 'quote'; targetUrl: string;
  createdAt: number; expiresAt: number; status: State; files: StoredFile[]; result?: MediaStageResult; errorCode?: string;
}
function fail(code: string, message = 'Remote media request could not complete.'): never { throw new ThreadsError(code, message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MEDIA');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_MEDIA');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_UPLOAD_ID', 'Use a client-generated UUID for the upload identifier.');
  return value.toLowerCase();
}
function manifest(value: unknown): MediaFileManifest {
  const file = object(value); exact(file, ['name', 'size', 'mime', 'sha256']);
  if (typeof file.name !== 'string' || !file.name || file.name.length > 180 || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(file.name) ||
      /[. ]$/.test(file.name) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(file.name)) fail('INVALID_MEDIA_NAME');
  if (typeof file.mime !== 'string' || !Object.hasOwn(mimeExtensions, file.mime) || !mimeExtensions[file.mime]!.includes(extname(file.name).toLowerCase())) fail('MEDIA_TYPE_MISMATCH');
  if (!Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > (file.mime.startsWith('image/') ? 8 * 1024 * 1024 : MAX_BYTES)) fail('MEDIA_SIZE_LIMIT');
  if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('INVALID_MEDIA_HASH');
  return { name: file.name, size: Number(file.size), mime: file.mime, sha256: file.sha256 };
}
function noReparse(path: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('MEDIA_STORAGE_UNSAFE');
    if (dirname(current) === current) break;
  }
}
function secureDirectory(root: string): void {
  noReparse(root); mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(root, 0o700); return; }
  const helper = fileURLToPath(new URL('../scripts/windows/Assert-PrivatePaths.ps1', import.meta.url));
  const child = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-StateDir', root, '-ConfigPath', join(root, 'policy.json'),
      '-TokenFile', join(root, 'unused.token'), '-ProtectState'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  if (child.status !== 0 || child.error) fail('MEDIA_STORAGE_ACL_REQUIRED');
}
function safeCode(error: unknown): string {
  const code = error instanceof ThreadsError ? error.code : 'REMOTE_MEDIA_FAILED';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'REMOTE_MEDIA_FAILED';
}

/** Host-lifetime controller. Receipt retention prevents finish replay across disconnects/restarts. */
export class RemoteMediaController {
  private readonly root: string;
  private readonly receiptsDir: string;
  private readonly dataDir: string;
  private readonly receipts = new Map<string, Receipt>();
  private readonly approvals = new Map<string, { uploadId: string; generation: number; expiresAt: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closed = false;
  private readonly expiry: ReturnType<typeof setInterval>;

  constructor(private readonly service: ThreadsService, private readonly raw: BrowserDriver, private readonly assertAccess: () => void) {
    this.root = resolve(service.config.dataDir, 'remote-media');
    this.receiptsDir = join(this.root, 'receipts'); this.dataDir = join(this.root, 'quarantine');
    try {
      secureDirectory(this.root);
      for (const dir of [this.receiptsDir, this.dataDir]) { noReparse(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); }
      this.recover();
    } catch (error) { fail(safeCode(error)); }
    this.expiry = setInterval(() => { try { this.expire(); } catch { /* Next request fails on its storage/access check. */ } }, 1000);
    this.expiry.unref();
  }
  private check(generation = this.generation): void {
    this.assertAccess();
    if (this.closed || generation !== this.generation) fail('REMOTE_MEDIA_REVOKED');
    if (!this.service.config.writesEnabled) fail('WRITES_DISABLED');
  }
  private contained(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('MEDIA_STORAGE_UNSAFE');
    noReparse(path);
  }
  private folder(receipt: Receipt): string { const folder = join(this.dataDir, receipt.storageId); this.contained(folder); return folder; }
  private filePath(receipt: Receipt, file: StoredFile): string {
    const path = join(this.folder(receipt), file.internalName); this.contained(path); return path;
  }
  private save(receipt: Receipt): void {
    const path = join(this.receiptsDir, `${receipt.storageId}.json`); this.contained(path);
    const temporary = join(this.receiptsDir, `${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
    } catch { fail('MEDIA_STORAGE_FAILED'); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* No temporary after rename. */ } }
  }
  private cleanup(receipt: Receipt): void {
    const folder = this.folder(receipt);
    if (!existsSync(folder)) return;
    // Remove only this receipt's generated files; never recurse through client paths or unrelated files.
    for (const file of receipt.files) { const path = this.filePath(receipt, file); try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('MEDIA_STORAGE_FAILED'); } }
    try { rmdirSync(folder); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) fail('MEDIA_STORAGE_FAILED'); }
  }
  private terminal(receipt: Receipt, status: State, errorCode?: string): void {
    if (receipt.result) this.approvals.delete(receipt.result.mediaToken);
    receipt.status = status; delete receipt.result;
    if (errorCode) receipt.errorCode = errorCode;
    this.save(receipt); this.cleanup(receipt);
  }
  private recover(): void {
    const files = readdirSync(this.receiptsDir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (files.length > MAX_RECEIPTS) fail('MEDIA_RECEIPT_LIMIT');
    for (const name of files) {
      const path = join(this.receiptsDir, name); this.contained(path);
      if (!lstatSync(path).isFile() || lstatSync(path).size > 32768) fail('MEDIA_STORAGE_CORRUPT');
      let receipt: Receipt;
      try {
        receipt = JSON.parse(readFileSync(path, 'utf8'));
        if (receipt.version !== 1 || identifier(receipt.storageId) + '.json' !== name || this.receipts.has(identifier(receipt.uploadId)) ||
          !Number.isSafeInteger(receipt.createdAt) || !Number.isSafeInteger(receipt.expiresAt) || !Array.isArray(receipt.files) || receipt.files.length < 1 || receipt.files.length > 20 ||
          !['receiving', 'finishing', 'staged', 'outcome-uncertain', 'failed', 'aborted', 'expired', 'revoked'].includes(receipt.status)) throw new Error();
        checkedRemoteSocialArgs({ kind: receipt.kind, targetUrl: receipt.targetUrl, expectedAccount: receipt.expectedAccount }, true);
        let total = 0;
        for (const file of receipt.files) {
          manifest({ name: file.name, size: file.size, mime: file.mime, sha256: file.sha256 }); total += file.size;
          if (!/^\d{1,2}-[0-9a-f-]{36}\.(jpg|jpeg|png|gif|webp|mp4|m4v|mov|webm)$/.test(file.internalName) ||
            !Number.isInteger(file.received) || file.received < 0 || file.received > file.size) throw new Error();
        }
        if (total > MAX_BYTES) throw new Error();
      } catch { return fail('MEDIA_STORAGE_CORRUPT'); }
      this.receipts.set(receipt.uploadId, receipt);
      if (receipt.status === 'finishing') this.terminal(receipt, 'outcome-uncertain', 'HOST_RESTARTED');
      else if (['receiving', 'staged'].includes(receipt.status)) this.terminal(receipt, 'expired', 'HOST_RESTARTED');
      else { delete receipt.result; this.save(receipt); this.cleanup(receipt); }
    }
    // Receipt temporary files carry only generated metadata, never media or credentials.
    for (const name of readdirSync(this.receiptsDir).filter(name => /^[0-9a-f-]{36}\.tmp$/.test(name))) {
      const path = join(this.receiptsDir, name); this.contained(path); if (lstatSync(path).isFile()) unlinkSync(path);
    }
  }
  private expire(): void {
    for (const receipt of this.receipts.values()) if (['receiving', 'finishing', 'staged'].includes(receipt.status) && Date.now() >= receipt.expiresAt)
      this.terminal(receipt, receipt.status === 'finishing' ? 'outcome-uncertain' : 'expired', 'MEDIA_EXPIRED');
  }
  private view(receipt: Receipt): object {
    return { uploadId: receipt.uploadId, status: receipt.status, expectedAccount: receipt.expectedAccount, kind: receipt.kind, targetUrl: receipt.targetUrl,
      expiresAt: new Date(receipt.expiresAt).toISOString(), files: receipt.files.map(file => ({ name: file.name, size: file.size, mime: file.mime, received: file.received })),
      ...(receipt.result ? { mediaToken: receipt.result.mediaToken, published: false, previewReady: null, fileCount: receipt.result.fileCount, warning: receipt.result.warning } : {}), ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}) };
  }
  handle(value: unknown): Promise<object> {
    const generation = this.generation;
    // Snapshot untrusted data before queueing, so a caller cannot mutate a pending request.
    let input: Record<string, unknown>;
    try { input = object(structuredClone(value)); } catch { return Promise.reject(new ThreadsError('INVALID_MEDIA', 'Use a supported media operation.')); }
    const result = this.queue.then(async () => {
      try { this.check(generation); this.expire(); return await this.dispatch(input, generation); }
      catch (error) { throw new ThreadsError(safeCode(error), 'Remote media operation could not complete. Inspect its status before another operation.'); }
    });
    this.queue = result.catch(() => undefined); return result;
  }
  private async dispatch(input: Record<string, unknown>, generation: number): Promise<object> {
    const operation = input.operation;
    if (!['begin', 'chunk', 'status', 'finish', 'abort'].includes(String(operation))) fail('INVALID_MEDIA');
    exact(input, operation === 'begin' ? ['operation', 'uploadId', 'expectedAccount', 'kind', 'targetUrl', 'files'] :
      operation === 'chunk' ? ['operation', 'uploadId', 'expectedAccount', 'fileIndex', 'offset', 'data'] : ['operation', 'uploadId', 'expectedAccount']);
    const uploadId = identifier(input.uploadId); const expectedAccount = remoteAccount(input.expectedAccount);
    if (expectedAccount.length > 30) fail('INVALID_MEDIA');
    let receipt = this.receipts.get(uploadId);
    if (receipt && receipt.expectedAccount !== expectedAccount) fail('ACCOUNT_MISMATCH');
    if (operation === 'begin') {
      if (!['publish', 'reply', 'quote'].includes(String(input.kind))) fail('INVALID_MEDIA');
      const args = checkedRemoteSocialArgs({ kind: input.kind, targetUrl: input.targetUrl, expectedAccount }, true);
      if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 20) fail('INVALID_MEDIA');
      const files = input.files.map(manifest);
      if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) fail('MEDIA_SIZE_LIMIT');
      if (receipt) {
        if (receipt.kind !== args.request.kind || receipt.targetUrl !== args.request.targetUrl || JSON.stringify(files) !== JSON.stringify(receipt.files.map(({ name, size, mime, sha256 }) => ({ name, size, mime, sha256 })))) fail('UPLOAD_ID_CONFLICT');
        return this.view(receipt);
      }
      if ([...this.receipts.values()].some(value => ['receiving', 'finishing'].includes(value.status))) fail('MEDIA_BUSY');
      if (this.receipts.size >= MAX_RECEIPTS) fail('MEDIA_RECEIPT_LIMIT');
      const now = Date.now();
      receipt = { version: 1, uploadId, storageId: randomUUID(), expectedAccount, kind: args.request.kind as Receipt['kind'], targetUrl: args.request.targetUrl,
        createdAt: now, expiresAt: now + UPLOAD_TTL, status: 'receiving', files: files.map((file, index) => ({ ...file, received: 0, internalName: `${index}-${randomUUID()}${extname(file.name).toLowerCase()}` })) };
      this.receipts.set(uploadId, receipt); this.save(receipt);
      try {
        mkdirSync(this.folder(receipt), { mode: 0o700 });
        for (const file of receipt.files) writeFileSync(this.filePath(receipt, file), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      } catch { this.terminal(receipt, 'failed', 'MEDIA_STORAGE_FAILED'); fail('MEDIA_STORAGE_FAILED'); }
      return this.view(receipt);
    }
    if (!receipt) fail('UPLOAD_NOT_FOUND');
    if (operation === 'status') return this.view(receipt);
    if (operation === 'abort') {
      if (['receiving', 'staged'].includes(receipt.status)) this.terminal(receipt, 'aborted');
      return this.view(receipt);
    }
    if (operation === 'finish') {
      if (receipt.status !== 'receiving') fail('UPLOAD_FINISH_CONSUMED');
      return this.finish(receipt, generation);
    }
    if (receipt.status !== 'receiving') fail('UPLOAD_NOT_RECEIVING');
    if (!Number.isInteger(input.fileIndex) || !Number.isInteger(input.offset) || typeof input.data !== 'string' ||
      input.data.length < 4 || input.data.length > 43692 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) fail('INVALID_MEDIA_CHUNK');
    const file = receipt.files[Number(input.fileIndex)];
    if (!file || input.offset !== file.received) fail('MEDIA_OFFSET_MISMATCH');
    const bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length || bytes.length > 32768 || bytes.toString('base64') !== input.data || bytes.length > file.size - file.received) fail('INVALID_MEDIA_CHUNK');
    let fd: number | undefined;
    try {
      fd = openSync(this.filePath(receipt, file), 'r+');
      let written = 0; while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, file.received + written);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      file.received += bytes.length; this.save(receipt);
    } catch { if (fd !== undefined) { closeSync(fd); fd = undefined; } this.terminal(receipt, 'failed', 'MEDIA_STORAGE_FAILED'); fail('MEDIA_STORAGE_FAILED'); }
    return this.view(receipt);
  }
  private async finish(receipt: Receipt, generation: number): Promise<object> {
    receipt.status = 'finishing'; this.save(receipt); // Durable before any possible browser side effect.
    let browserFinishSent = false;
    const active = () => {
      this.check(generation);
      if (receipt.status !== 'finishing' || Date.now() >= receipt.expiresAt) fail('MEDIA_EXPIRED');
    };
    try {
      for (const file of receipt.files) {
        if (file.received !== file.size) fail('MEDIA_INCOMPLETE');
        const path = this.filePath(receipt, file); const stat = lstatSync(path);
        if (!stat.isFile() || stat.size !== file.size) fail('MEDIA_FILE_CHANGED');
        const bytes = readFileSync(path);
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('MEDIA_HASH_MISMATCH');
        if (mediaMime(bytes, extname(file.name)) !== file.mime) fail('MEDIA_TYPE_MISMATCH');
      }
      active();
      const result = await this.service.serial(async () => {
        active();
        let page = await this.raw.command<PageRead & { remoteMediaVersion?: number }>({ type: 'read' });
        active(); assertRemoteViewer(page, receipt.expectedAccount); assertRemoteDraftSafe(page);
        if (page.remoteMediaVersion !== 1) fail('REMOTE_MEDIA_RUNTIME_REQUIRED');
        if (!sameThreadsRoute(page.url, receipt.targetUrl)) {
          active(); await this.raw.command({ type: 'navigate', url: receipt.targetUrl }); active();
        }
        page = await this.raw.command<PageRead & { remoteMediaVersion?: number }>({ type: 'read' });
        active(); assertRemoteViewer(page, receipt.expectedAccount); assertRemoteDraftSafe(page);
        if (page.remoteMediaVersion !== 1) fail('REMOTE_MEDIA_RUNTIME_REQUIRED');
        if (!sameThreadsRoute(page.url, receipt.targetUrl)) fail('TARGET_CHANGED_ROUTE');
        const controller = new MediaController({ writesEnabled: this.service.config.writesEnabled, command: async <T>(command: Record<string, unknown>): Promise<T> => {
          active();
          if (command.operation === 'begin') {
            const actual = command.files as MediaFileManifest[];
            if (!Array.isArray(actual) || actual.length !== receipt.files.length || actual.some((file, index) =>
              file.sha256 !== receipt.files[index]!.sha256 || file.size !== receipt.files[index]!.size || file.mime !== receipt.files[index]!.mime)) fail('MEDIA_FILE_CHANGED');
          }
          const composed = command.operation === 'begin' ? { ...command, compose: { kind: receipt.kind, targetUrl: receipt.targetUrl } } : command;
          if (command.operation === 'finish') browserFinishSent = true;
          const response = await this.raw.command<T>(composed);
          active(); return response;
        } });
        return controller.uploadFiles(receipt.files.map(file => this.filePath(receipt, file)), receipt.expectedAccount);
      });
      active();
      if (!result || result.status !== 'staged' || typeof result.mediaToken !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.mediaToken) ||
          result.published !== false || result.previewReady !== null || result.fileCount !== receipt.files.length) fail('INVALID_MEDIA_RESPONSE');
      receipt.status = 'staged'; receipt.expiresAt = Date.now() + APPROVAL_TTL;
      receipt.result = { status: 'staged', mediaToken: result.mediaToken, fileCount: receipt.files.length, files: receipt.files.map(file => file.name), published: false, previewReady: null,
        warning: 'Files were staged with generated private filenames. Inspect the attachment previews before preparing publication; no publication occurred.' };
      this.save(receipt);
      this.approvals.set(result.mediaToken, { uploadId: receipt.uploadId, generation, expiresAt: receipt.expiresAt });
      return this.view(receipt);
    } catch (error) {
      if (receipt.status === 'finishing') this.terminal(receipt, browserFinishSent ? 'outcome-uncertain' : 'failed', safeCode(error));
      else if (receipt.status === 'staged') this.terminal(receipt, 'outcome-uncertain', safeCode(error));
      throw error;
    } finally { this.cleanup(receipt); }
  }
  authorize(request: SocialRequest, expectedAccount: string): void {
    try {
      this.check(); this.expire();
      const approval = typeof request.mediaToken === 'string' ? this.approvals.get(request.mediaToken) : undefined;
      const receipt = approval ? this.receipts.get(approval.uploadId) : undefined;
      if (!approval || !receipt || approval.generation !== this.generation || approval.expiresAt <= Date.now() || receipt.status !== 'staged' ||
          receipt.expectedAccount !== remoteAccount(expectedAccount) || receipt.kind !== request.kind || receipt.targetUrl !== request.targetUrl || receipt.result?.mediaToken !== request.mediaToken) fail('REMOTE_MEDIA_NOT_AUTHORIZED');
    } catch (error) { throw new ThreadsError(safeCode(error), 'Remote media approval is missing, expired or does not match this account and target.'); }
  }
  invalidate(): void {
    this.generation++; this.approvals.clear();
    for (const receipt of this.receipts.values()) if (['receiving', 'finishing', 'staged'].includes(receipt.status)) {
      try { this.terminal(receipt, receipt.status === 'finishing' ? 'outcome-uncertain' : 'revoked', 'REMOTE_MEDIA_REVOKED'); }
      catch { /* Never restore an approval; active finish retries its own file cleanup. */ }
    }
  }
  close(): void { if (this.closed) return; this.invalidate(); this.closed = true; clearInterval(this.expiry); }
}
