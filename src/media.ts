import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { ThreadsError } from './types.js';

export interface MediaFileManifest { name: string; mime: string; size: number; sha256: string; }
export interface MediaStageResult { status: 'staged'; mediaToken: string; fileCount: number; files: string[]; published: false; previewReady: null; warning: string; }
export interface MediaOptions {
  writesEnabled: boolean;
  command: <T>(command: Record<string, unknown>) => Promise<T>;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  maxTotalBytes?: number;
}
const MiB = 1024 * 1024;
export const MEDIA_CHUNK_BYTES = 32 * 1024;
export const MEDIA_MAX_TOTAL_BYTES = 64 * MiB;

/** Local-file signatures are checked before any bytes are sent to the selected tab. */
export function mediaMime(bytes: Uint8Array, extension: string): string {
  const b = Buffer.from(bytes);
  const ext = extension.toLowerCase();
  const candidates: Array<[boolean, string, string[]]> = [
    [b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/jpeg', ['.jpg', '.jpeg']],
    [b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png', ['.png']],
    [/^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii')), 'image/gif', ['.gif']],
    [b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP', 'image/webp', ['.webp']],
    [b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' && b.subarray(8, 12).toString('ascii') === 'qt  ', 'video/quicktime', ['.mov']],
    [b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(b.subarray(8, 12).toString('ascii')), 'video/mp4', ['.mp4', '.m4v']],
    [b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && b.subarray(0, 4096).includes(Buffer.from('webm')), 'video/webm', ['.webm']],
  ];
  const match = candidates.find(([matches]) => matches);
  if (!match || !match[2].includes(ext)) throw new ThreadsError('MEDIA_TYPE_MISMATCH', 'Unsupported media signature or filename extension mismatch.');
  return match[1];
}

export class MediaController {
  private busy = false;
  constructor(private readonly options: MediaOptions) {}

  async uploadFiles(paths: string[], expectedAccount: string, altTexts?: string[]): Promise<MediaStageResult> {
    if (!this.options.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Enable writes before staging media.');
    if (this.busy) throw new ThreadsError('MEDIA_BUSY', 'Another media transfer is in progress.');
    if (altTexts?.length) throw new ThreadsError('MEDIA_ALT_TEXT_UNSUPPORTED', 'Browser alt text cannot be set reliably; no media was staged. Use an explicitly supported route.');
    if (!/^[\w.]{1,30}$/.test(expectedAccount) || !Array.isArray(paths) || paths.length < 1 || paths.length > 20)
      throw new ThreadsError('INVALID_MEDIA', 'Provide an expected account and between 1 and 20 local files.');
    const limit = (value: number | undefined, fallback: number) => Math.min(fallback, Number.isSafeInteger(value) && value! > 0 ? value! : fallback);
    const maxImage = limit(this.options.maxImageBytes, 8 * MiB);
    const maxVideo = limit(this.options.maxVideoBytes, MEDIA_MAX_TOTAL_BYTES);
    const maxTotal = limit(this.options.maxTotalBytes, MEDIA_MAX_TOTAL_BYTES);
    this.busy = true;
    let uploadId: string | undefined;
    let finishing = false;
    try {
      const files: Array<{ manifest: MediaFileManifest; bytes: Buffer }> = [];
      let total = 0;
      for (const path of paths) {
        if (typeof path !== 'string' || !isAbsolute(path) || /^\\\\/.test(path) || /^\/\//.test(path)) throw new ThreadsError('INVALID_MEDIA_PATH', 'Media paths must be explicit absolute local paths; network and device paths are unsupported.');
        const name = basename(path);
        if (!name || name.length > 180 || /[\x00-\x1f\x7f]/.test(name)) throw new ThreadsError('INVALID_MEDIA_PATH', 'Invalid media filename.');
        let handle;
        try {
          handle = await open(path, 'r');
          const before = await handle.stat();
          if (!before.isFile() || before.size < 1 || before.size > maxTotal - total) throw new ThreadsError('MEDIA_SIZE_LIMIT', 'Media must be regular nonempty files within the total byte limit.');
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const part = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!part.bytesRead) throw new ThreadsError('MEDIA_FILE_CHANGED', 'Media file changed while being read.');
            offset += part.bytesRead;
          }
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ThreadsError('MEDIA_FILE_CHANGED', 'Media file changed while being read.');
          const mime = mediaMime(bytes, extname(name));
          if (bytes.length > (mime.startsWith('image/') ? maxImage : maxVideo)) throw new ThreadsError('MEDIA_SIZE_LIMIT', 'Media file exceeds the per-file byte limit.');
          total += bytes.length;
          files.push({ bytes, manifest: { name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
        } catch (error) {
          if (error instanceof ThreadsError) throw error;
          throw new ThreadsError('MEDIA_FILE_UNREADABLE', 'Could not read the specified local media file.');
        } finally { await handle?.close(); }
      }
      const begin = await this.options.command<{ uploadId: string }>({ type: 'media', operation: 'begin', expectedAccount, files: files.map(file => file.manifest) });
      if (!/^[\w-]{1,100}$/.test(begin.uploadId)) throw new ThreadsError('INVALID_MEDIA_RESPONSE', 'The browser returned an invalid media transfer identifier.');
      uploadId = begin.uploadId;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const bytes = files[fileIndex]!.bytes;
        for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
          await this.options.command({ type: 'media', operation: 'chunk', uploadId, fileIndex, offset,
            data: bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64') });
        }
      }
      finishing = true;
      return await this.options.command<MediaStageResult>({ type: 'media', operation: 'finish', uploadId });
    } catch (error) {
      // Abort only discards buffered bytes. A failed finish can already have dispatched files;
      // never clear the composer or replay it in an attempt to recover an uncertain result.
      if (uploadId && !finishing) await this.options.command({ type: 'media', operation: 'abort', uploadId }).catch(() => undefined);
      throw error;
    } finally { this.busy = false; }
  }
}
