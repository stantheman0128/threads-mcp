import type { MediaFileManifest, MediaStageResult } from './media.js';
import { assertMediaComposerBinding, openMediaComposer, type MediaComposerBinding, type MediaComposeRequest } from './social-runtime.js';

interface Transfer {
  id: string; generation: number; expires: number; timer: ReturnType<typeof setTimeout>; url: string; account: string;
  dialog: HTMLElement; editor: HTMLElement; input: HTMLInputElement; fingerprint: string; manualEpoch: number; binding?: MediaComposerBinding;
  files: Array<{ manifest: MediaFileManifest; bytes: Uint8Array; received: number }>;
}
let transfer: Transfer | undefined;
let generation = 0;
let opening = false, manualEpoch = 0;
let removeManualWatch: (() => void) | undefined;
let approved: { token: string; expires: number; timer: ReturnType<typeof setTimeout>; url: string; account: string; dialog: HTMLElement; editor: HTMLElement; attachmentScope: HTMLElement; input: HTMLInputElement; files: File[]; manualEpoch: number; binding?: MediaComposerBinding; previews?: Array<{ node: Element; source: string | null }> } | undefined;
const maxTotal = 64 * 1024 * 1024;
function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function visible(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' &&
    getComputedStyle(el).display !== 'none' && !el.closest('[aria-hidden="true"]');
}
function account(): string {
  const accounts = [...document.querySelectorAll('a[href^="/@"]')].filter(visible)
    .filter(el => /^(Profile|個人檔案)$/i.test(el.getAttribute('aria-label') || el.querySelector('svg')?.getAttribute('aria-label') || ''))
    .map(el => el.getAttribute('href')?.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter(Boolean);
  if (new Set(accounts).size !== 1) fail('ACCOUNT_UNVERIFIED', 'A unique visible account profile control is required.');
  return accounts[0]!;
}
function guard(): void {
  if (location.protocol !== 'https:' || !['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(location.hostname))
    fail('WRONG_PAGE', 'Only a selected HTTPS Threads page is supported.');
}
function attachmentScope(dialog: HTMLElement, editor: HTMLElement): HTMLElement {
  const body = editor.closest<HTMLElement>('[data-barcelona-composer-body="true"]');
  return body && dialog.contains(body) ? body : dialog;
}
function fingerprint(dialog: HTMLElement, editor: HTMLElement, input: HTMLInputElement): string {
  return JSON.stringify([editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent,
    editor.getAttribute('contenteditable'), editor.getAttribute('aria-label'), input.accept, input.multiple, input.disabled,
    [...(input.files || [])].map(file => [file.name, file.size, file.type, file.lastModified]),
    [...dialog.querySelectorAll('img[src^="blob:"],video,button[aria-label],[role="button"][aria-label]')]
      .map(el => [el.tagName, el.getAttribute('src'), el.getAttribute('aria-label')])]);
}
function composer(): { dialog: HTMLElement; editor: HTMLElement; input: HTMLInputElement } {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  if (dialogs.length !== 1) fail('MEDIA_COMPOSER_REQUIRED', 'Open exactly one empty composer dialog before staging files.');
  const dialog = dialogs[0]!;
  const editors = [...dialog.querySelectorAll('[contenteditable="true"],textarea')].filter(visible);
  const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  if (editors.length !== 1 || inputs.length !== 1) fail('MEDIA_COMPOSER_AMBIGUOUS', 'A unique composer and file input are required.');
  const editor = editors[0]!;
  const input = inputs[0]!;
  const text = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent || '';
  // Source-post media in a reply/quote dialog is outside the editable composer body.
  const attachments = attachmentScope(dialog, editor);
  const previews = [...attachments.querySelectorAll('img,video')].some(el => el.tagName === 'VIDEO' ||
    !/(profile picture|profile photo|大頭貼|頭像)/i.test(el.getAttribute('alt') || ''));
  const removeControls = [...attachments.querySelectorAll('[aria-label]')].some(el => /^(Remove|Delete|移除|刪除)(?:$|\s*(media|image|photo|video|attachment|圖片|相片|影片|附件))/i.test(el.getAttribute('aria-label') || ''));
  if (text.trim() || input.files?.length || previews || removeControls) fail('MEDIA_DRAFT_EXISTS', 'Existing draft text or attachments must be preserved; use an empty composer.');
  if (input.disabled || input.getAttribute('aria-disabled') === 'true' || editor.getAttribute('aria-disabled') === 'true') fail('MEDIA_INPUT_DISABLED', 'The composer is disabled.');
  return { dialog, editor, input };
}
function check(current: Transfer): void {
  guard();
  if (current.generation !== generation) fail('MEDIA_CANCELLED', 'The transfer was cancelled; no files were dispatched.');
  if (Date.now() > current.expires) { clear(); fail('MEDIA_EXPIRED', 'The transfer expired.'); }
  if (manualEpoch !== current.manualEpoch || location.href !== current.url || account() !== current.account || !current.dialog.isConnected || !current.input.isConnected ||
      !current.editor.isConnected || !visible(current.dialog) || !visible(current.editor) ||
      fingerprint(current.dialog, current.editor, current.input) !== current.fingerprint)
    fail('MEDIA_COMPOSER_CHANGED', 'The account, page, composer or file input changed; no files were dispatched.');
  const fresh = composer();
  if (fresh.dialog !== current.dialog || fresh.editor !== current.editor || fresh.input !== current.input)
    fail('MEDIA_COMPOSER_CHANGED', 'The composer changed; no files were dispatched.');
  if (current.binding) assertMediaComposerBinding(current.binding);
}
function watchManualTakeover(): void {
  if (removeManualWatch) return;
  const events = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'wheel'];
  const listener = (event: Event) => { if (event.isTrusted) manualEpoch++; };
  for (const type of events) document.addEventListener(type, listener, true);
  removeManualWatch = () => { for (const type of events) document.removeEventListener(type, listener, true); };
}
function clear(): void { if (transfer) clearTimeout(transfer.timer); transfer = undefined; }
/** Called only by the fixed extension disconnect handler. Preserves user-visible drafts. */
export function cancelMediaTransfers(): void {
  generation++;
  clear();
  if (approved) clearTimeout(approved.timer);
  approved = undefined;
  removeManualWatch?.(); removeManualWatch = undefined;
}
function accepts(input: HTMLInputElement, file: MediaFileManifest): boolean {
  const accept = input.accept.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return !accept.length || accept.some(value => value === file.mime || value === `${file.mime.split('/')[0]}/*` ||
    (value.startsWith('.') && file.name.toLowerCase().endsWith(value)));
}

/** Require the same staged files plus visible attachment evidence before social prepare/commit. */
export function assertApprovedMedia(mediaToken: string, scope: HTMLElement): MediaComposerBinding | undefined {
  guard();
  const state = approved;
  if (!state || state.manualEpoch !== manualEpoch || state.token !== mediaToken || Date.now() > state.expires || location.href !== state.url || account() !== state.account ||
      scope !== state.dialog || !scope.isConnected || !visible(scope) || !state.input.isConnected || !scope.contains(state.input))
    fail('MEDIA_APPROVAL_STALE', 'The staged media approval is missing, expired or belongs to another composer.');
  const files = [...(state.input.files || [])];
  if (files.length !== state.files.length || files.some((file, index) => file !== state.files[index]))
    fail('MEDIA_APPROVAL_STALE', 'The composer attachments changed.');
  const attachments = attachmentScope(scope, state.editor);
  if (attachments !== state.attachmentScope) fail('MEDIA_APPROVAL_STALE', 'The editable attachment region changed.');
  const previews = [...attachments.querySelectorAll('img[src^="blob:"],video')].filter(visible).map(node => ({ node, source: node.getAttribute('src') }));
  if (previews.length !== state.files.length) fail('MEDIA_PREVIEW_UNVERIFIED', 'Every staged file needs one visible attachment preview; missing or additional previews cannot be approved.');
  if (state.previews && (previews.length !== state.previews.length || previews.some((preview, index) =>
    preview.node !== state.previews![index]!.node || preview.source !== state.previews![index]!.source)))
    fail('MEDIA_APPROVAL_STALE', 'The attachment preview changed after preparation.');
  state.previews ??= previews;
  if (state.binding) assertMediaComposerBinding(state.binding);
  return state.binding;
}

/** Fixed commands only. Buffers expire; finish stages files and never clicks Publish. */
export async function media(command: Record<string, unknown>): Promise<unknown> {
  guard();
  if (transfer && Date.now() > transfer.expires) clear();
  if (command.operation === 'begin') {
    if (transfer || opening) fail('MEDIA_BUSY', 'Another transfer is already pending.');
    if (typeof command.expectedAccount !== 'string' || !/^[\w.]{1,30}$/.test(command.expectedAccount)) fail('INVALID_MEDIA', 'An expected account is required.');
    const verifiedAccount = account();
    if (command.expectedAccount.toLowerCase() !== verifiedAccount) fail('ACCOUNT_MISMATCH', 'The selected account does not match.');
    if (!Array.isArray(command.files) || command.files.length < 1 || command.files.length > 20) fail('INVALID_MEDIA', 'Provide between 1 and 20 files.');
    let total = 0;
    const manifests = command.files.map((file: MediaFileManifest) => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name) ||
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'].includes(file.mime) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > (file.mime.startsWith('image/') ? 8 * 1024 * 1024 : maxTotal) ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('INVALID_MEDIA', 'Invalid file manifest.');
      total += file.size;
      if (total > maxTotal) fail('MEDIA_SIZE_LIMIT', 'The total byte limit is 64 MiB.');
      return { name: file.name, mime: file.mime, size: file.size, sha256: file.sha256 };
    });
    // Validate every manifest and byte bound before opening any UI.
    const expectedGeneration = generation, expectedManualEpoch = manualEpoch;
    watchManualTakeover();
    let binding: MediaComposerBinding | undefined;
    if (command.compose !== undefined) {
      opening = true;
      try { binding = await openMediaComposer(command.compose as MediaComposeRequest, verifiedAccount); }
      finally { opening = false; }
    }
    if (generation !== expectedGeneration) fail('MEDIA_CANCELLED', 'The transfer was cancelled while opening its composer.');
    if (manualEpoch !== expectedManualEpoch) fail('MEDIA_COMPOSER_CHANGED', 'Manual interaction took ownership of the composer.');
    if (account() !== verifiedAccount) fail('ACCOUNT_MISMATCH', 'The selected account changed.');
    const { dialog, editor, input } = composer();
    if (binding && (binding.scope !== dialog || binding.editor !== editor)) fail('MEDIA_COMPOSER_CHANGED', 'The opened composer was replaced.');
    if (manifests.length > 1 && !input.multiple) fail('MEDIA_MULTIPLE_UNSUPPORTED', 'The selected file input does not accept multiple files.');
    if (manifests.some(file => !accepts(input, file))) fail('MEDIA_INPUT_TYPE_UNSUPPORTED', 'The file input does not accept this media type.');
    const id = crypto.randomUUID();
    transfer = { id, generation, url: location.href, account: verifiedAccount, expires: Date.now() + 300_000,
      timer: setTimeout(clear, 300_000), dialog, editor, input, fingerprint: fingerprint(dialog, editor, input), manualEpoch, binding,
      files: manifests.map(manifest => ({ manifest, bytes: new Uint8Array(manifest.size), received: 0 })) };
    return { uploadId: id, expiresInMs: 300_000, maxChunkBytes: 32 * 1024 };
  }
  if (!transfer || transfer.id !== command.uploadId) fail('MEDIA_TRANSFER_MISSING', 'No matching pending transfer.');
  if (command.operation === 'abort') { clear(); return { aborted: true, composerChanged: false }; }
  const current = transfer;
  check(current);
  if (command.operation === 'chunk') {
    if (!Number.isInteger(command.fileIndex) || !Number.isInteger(command.offset) || typeof command.data !== 'string' ||
      command.data.length < 4 || command.data.length > 43692 || !/^[A-Za-z0-9+/]+={0,2}$/.test(command.data)) fail('INVALID_MEDIA_CHUNK', 'Invalid bounded base64 chunk.');
    const file = current.files[command.fileIndex as number];
    if (!file || command.offset !== file.received) fail('INVALID_MEDIA_CHUNK', 'Chunks must arrive once in order.');
    const decoded = atob(command.data);
    if (btoa(decoded) !== command.data || decoded.length > 32768 || decoded.length > file.bytes.length - file.received) fail('INVALID_MEDIA_CHUNK', 'Chunk exceeds the remaining file size.');
    file.bytes.set(Uint8Array.from(decoded, value => value.charCodeAt(0)), file.received);
    file.received += decoded.length;
    return { received: file.received, fileIndex: command.fileIndex };
  }
  if (command.operation !== 'finish') fail('INVALID_MEDIA_COMMAND', 'Unknown media operation.');
  // Consume the transfer before asynchronous hashing or dispatch; finish cannot be replayed.
  clear();
  for (const file of current.files) {
    if (file.received !== file.manifest.size) fail('MEDIA_INCOMPLETE', 'All file bytes must be transferred before staging.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes as Uint8Array<ArrayBuffer>));
    if ([...digest].map(value => value.toString(16).padStart(2, '0')).join('') !== file.manifest.sha256) fail('MEDIA_HASH_MISMATCH', 'The transferred file does not match its manifest.');
  }
  check(current);
  const data = new DataTransfer();
  for (const file of current.files) data.items.add(new File([file.bytes as Uint8Array<ArrayBuffer>], file.manifest.name, { type: file.manifest.mime }));
  current.input.files = data.files;
  current.input.dispatchEvent(new Event('input', { bubbles: true }));
  current.input.dispatchEvent(new Event('change', { bubbles: true }));
  const mediaToken = crypto.randomUUID();
  if (approved) clearTimeout(approved.timer);
  approved = { token: mediaToken, expires: Date.now() + 600_000, timer: setTimeout(() => { approved = undefined; }, 600_000), url: current.url, account: current.account,
    dialog: current.dialog, editor: current.editor, attachmentScope: attachmentScope(current.dialog, current.editor), input: current.input, files: [...data.files], manualEpoch: current.manualEpoch, binding: current.binding };
  const result: MediaStageResult = { status: 'staged', mediaToken, fileCount: current.files.length, files: current.files.map(file => file.manifest.name),
    published: false, previewReady: null, warning: 'Files were assigned and input events dispatched. Inspect the actual preview and wait for processing before preparing publication.' };
  return result;
}
