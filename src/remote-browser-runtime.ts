export interface RemoteBrowserRef { ref: string; kind: 'navigation' | 'search'; name: string; verb: 'click' | 'fill'; url?: string; }
export interface RemoteBrowserSnapshot {
  snapshotId: string; account: string; url: string; observedAt: string; expiresAt: string;
  elements: RemoteBrowserRef[]; scope: 'public-read-navigation'; warnings: string[];
}
interface Candidate { node: HTMLElement; descriptor: Omit<RemoteBrowserRef, 'ref'>; fingerprint: string; }
interface SnapshotBinding { id: string; account: string; route: string; epoch: number; expires: number; entries: Map<string, Candidate>; }
interface Preparation { token: string; binding: SnapshotBinding; candidate: Candidate; destination: string; }
let snapshot: SnapshotBinding | undefined, preparation: Preparation | undefined;
let epoch = 0, watching = false;
const ttl = 60_000;
const warning = 'Narrow read-navigation fallback only. No generic UI interaction, social controls, private text, messages or settings are exposed.';
function fail(code: string): never { throw new Error(`${code}: Remote browser navigation could not be validated.`); }

/** Host/extension transport validator. Unknown keys cannot introduce an alternate command surface. */
export function validateRemoteBrowserCommand(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, { required: string[]; optional?: string[] }> = {
    snapshot: { required: ['expectedAccount'] }, scroll: { required: ['expectedAccount', 'pixels'] },
    prepare: { required: ['expectedAccount', 'snapshotId', 'ref', 'verb', 'purpose'], optional: ['value'] },
    consume: { required: ['expectedAccount', 'token'] }, invalidate: { required: [] },
  };
  const rule = typeof input.operation === 'string' && Object.hasOwn(fields, input.operation) ? fields[input.operation] : undefined;
  if (input.type !== 'remote_browser' || !rule || rule.required.some(key => !Object.hasOwn(input, key)) ||
      Object.keys(input).some(key => !['type', 'operation', ...rule.required, ...(rule.optional ?? [])].includes(key))) fail('INVALID_COMMAND');
  if (input.operation !== 'invalidate') expectedAccount(input.expectedAccount);
  if (input.operation === 'scroll' && (!Number.isInteger(input.pixels) || Number(input.pixels) === 0 || Math.abs(Number(input.pixels)) > 2000)) fail('INVALID_COMMAND');
  if (input.operation === 'consume' && (typeof input.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.token))) fail('INVALID_COMMAND');
  if (input.operation === 'prepare') {
    if (typeof input.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.snapshotId) || typeof input.ref !== 'string' || !/^r\d{1,2}$/.test(input.ref) ||
        !['click', 'fill'].includes(String(input.verb)) || typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 300 || /[\x00-\x1f\x7f]/.test(input.purpose)) fail('INVALID_COMMAND');
    if (input.verb === 'click' ? input.value !== undefined : typeof input.value !== 'string' || !input.value.trim() || [...input.value].length > 200 || /[\x00-\x1f\x7f]/.test(input.value)) fail('INVALID_COMMAND');
  }
  return { ...input };
}

/** Shared pure route contract. Query parameters are allowed only on public search. */
export function checkedRemoteBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) fail('REMOTE_BROWSER_ROUTE_DENIED');
  let url: URL; try { url = new URL(value); } catch { return fail('REMOTE_BROWSER_ROUTE_DENIED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(url.hostname)) fail('REMOTE_BROWSER_ROUTE_DENIED');
  url.hostname = 'www.threads.com';
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  if (!/^(?:\/|\/(?:search|following|saved|liked)|\/@[A-Za-z0-9_.]{1,64}(?:\/(?:replies|media|reposts))?|\/(?:@[A-Za-z0-9_.]{1,64}\/)?post\/[A-Za-z0-9_-]{1,100})$/.test(url.pathname)) fail('REMOTE_BROWSER_ROUTE_DENIED');
  if (url.pathname !== '/search' && url.search) fail('REMOTE_BROWSER_ROUTE_DENIED');
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['q', 'serp_type', 'filter'].includes(key))) fail('REMOTE_BROWSER_ROUTE_DENIED');
  const query = url.searchParams.get('q');
  if (query !== null && (!query.trim() || [...query].length > 200 || /[\x00-\x1f\x7f]/.test(query))) fail('REMOTE_BROWSER_ROUTE_DENIED');
  if (url.searchParams.has('serp_type') && url.searchParams.get('serp_type') !== 'default') fail('REMOTE_BROWSER_ROUTE_DENIED');
  if (url.searchParams.has('filter') && !['recent', 'profiles'].includes(url.searchParams.get('filter')!)) fail('REMOTE_BROWSER_ROUTE_DENIED');
  url.searchParams.sort();
  return url.href;
}
export function remoteBrowserRouteName(value: string): string {
  const url = new URL(checkedRemoteBrowserUrl(value));
  if (url.pathname === '/') return 'Home';
  if (url.pathname === '/search') return 'Public search';
  if (['/following', '/saved', '/liked'].includes(url.pathname)) return `${url.pathname.slice(1)} feed`;
  return url.pathname.includes('/post/') || url.pathname.startsWith('/post/') ? `Post ${url.pathname}` : `Profile ${url.pathname}`;
}
function visible(node: Element): node is HTMLElement {
  return node instanceof HTMLElement && node.isConnected && !!node.getClientRects().length &&
    getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[aria-hidden="true"],[inert]');
}
function expectedAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^@?[A-Za-z0-9_.]{1,64}$/.test(value)) fail('INVALID_INPUT');
  return value.replace(/^@/, '').toLowerCase();
}
function currentAccount(): string {
  const names = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible).flatMap(node => {
    const label = node.getAttribute('aria-label') || node.querySelector('svg')?.getAttribute('aria-label') || '';
    if (!/^(Profile|個人檔案)$/i.test(label.trim())) return [];
    try { const url = new URL(checkedRemoteBrowserUrl(new URL(node.getAttribute('href')!, location.origin).href));
      const match = /^\/@([A-Za-z0-9_.]{1,64})$/.exec(url.pathname); return match ? [match[1]!.toLowerCase()] : []; } catch { return []; }
  });
  if (new Set(names).size !== 1) fail('ACCOUNT_UNVERIFIED');
  return names[0]!;
}
function searchInput(node: Element): node is HTMLInputElement {
  if (!(node instanceof HTMLInputElement) || !visible(node) || node.disabled || node.readOnly ||
      !['search', 'text'].includes(node.type) || !(node.type === 'search' || node.getAttribute('role') === 'searchbox') ||
      !/^(Search|Search Threads|搜尋|搜尋串文)$/i.test((node.getAttribute('aria-label') || node.placeholder || '').trim())) return false;
  if (node.form) {
    if (node.form.method.toLowerCase() !== 'get') return false;
    try { if (new URL(checkedRemoteBrowserUrl(new URL(node.form.getAttribute('action') || location.href, location.origin).href)).pathname !== '/search') return false; } catch { return false; }
  }
  return true;
}
function assertSafe(account: string): void {
  checkedRemoteBrowserUrl(location.href);
  if (currentAccount() !== account) fail('ACCOUNT_MISMATCH');
  if ([...document.querySelectorAll('[role="dialog"],[role="menu"],input[type="password"]')].some(visible)) fail('COMPOSER_BUSY');
  if ([...document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],input')].some(node => {
    if (node instanceof HTMLInputElement && node.type === 'file') return !!node.files?.length;
    if (!visible(node)) return false;
    if (searchInput(node)) return !!node.value.trim();
    return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? !!node.value.trim() : !!node.innerText.trim();
  })) fail('COMPOSER_BUSY');
  if ([...document.querySelectorAll('[data-barcelona-composer-body="true"]')].some(node => visible(node) && !!node.querySelector('img,video,input[type="file"]'))) fail('COMPOSER_BUSY');
}
function invalidate(): void { snapshot = undefined; preparation = undefined; }
export function cancelRemoteBrowserActions(): void { epoch++; invalidate(); }
function watch(): void {
  if (watching) return;
  watching = true;
  const manual = (event: Event) => { if (event.isTrusted) { epoch++; invalidate(); } };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'wheel']) document.addEventListener(type, manual, true);
  globalThis.addEventListener('pagehide', () => { epoch++; invalidate(); });
}
function candidate(node: HTMLElement): Candidate | undefined {
  if (!visible(node) || node.closest('button,[role="button"],[role="menu"],[role="dialog"],[contenteditable="true"]')) return;
  if ([...node.attributes].some(attribute => /^on/i.test(attribute.name)) || node.hasAttribute('aria-haspopup') || node.getAttribute('aria-disabled') === 'true') return;
  if (node instanceof HTMLAnchorElement) {
    if (node.hasAttribute('download') || node.hasAttribute('ping') || node.getAttribute('role') && node.getAttribute('role') !== 'link') return;
    const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
    if (/^(?:like|unlike|follow|unfollow|delete|publish|reply|quote|repost|save|unsave|messages?|activity|notifications?|settings|password|log\s?in|log\s?out|sign\s?in|sign\s?out|刪除|發佈|發布|回覆|引用|轉發|追蹤|取消追蹤|讚|收回讚|訊息|通知|設定|密碼|登入|登出)(?:\s|$)/i.test(label)) return;
    const href = node.getAttribute('href');
    if (!href || href.startsWith('#') || href.includes('\\')) return;
    let url: string;
    try { url = checkedRemoteBrowserUrl(new URL(href, location.origin).href); } catch { return; }
    const descriptor = { kind: 'navigation' as const, name: remoteBrowserRouteName(url), verb: 'click' as const, url };
    return { node, descriptor, fingerprint: JSON.stringify([node.getAttribute('href'), node.getAttribute('role'), node.getAttribute('aria-label'), descriptor]) };
  }
  if (searchInput(node) && !node.value.trim()) {
    const descriptor = { kind: 'search' as const, name: 'Public search query', verb: 'fill' as const };
    return { node, descriptor, fingerprint: JSON.stringify([node.type, node.getAttribute('role'), node.getAttribute('aria-label'), node.placeholder, node.value, node.form?.getAttribute('action')]) };
  }
}
function makeSnapshot(account: string): RemoteBrowserSnapshot {
  assertSafe(account); watch(); invalidate();
  const binding: SnapshotBinding = { id: crypto.randomUUID(), account, route: location.href, epoch, expires: Date.now() + ttl, entries: new Map() };
  const elements: RemoteBrowserRef[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('a[href],input')) {
    if (elements.length >= 80) break;
    const value = candidate(node); if (!value) continue;
    const ref = `r${elements.length + 1}`;
    binding.entries.set(ref, value); elements.push({ ref, ...value.descriptor });
  }
  snapshot = binding;
  return { snapshotId: binding.id, account, url: checkedRemoteBrowserUrl(binding.route), observedAt: new Date().toISOString(), expiresAt: new Date(binding.expires).toISOString(), elements, scope: 'public-read-navigation', warnings: [warning] };
}
function assertBinding(binding: SnapshotBinding, account: string): void {
  assertSafe(account);
  if (Date.now() >= binding.expires || binding.epoch !== epoch || binding.route !== location.href || binding.account !== account) fail('REMOTE_BROWSER_STALE');
}
/** Fixed semantic navigation. No click, fill, submit, press, select, check or arbitrary JS is dispatched. */
export function remoteBrowser(command: Record<string, unknown>): unknown {
  validateRemoteBrowserCommand({ type: 'remote_browser', ...command });
  if (command.operation === 'invalidate') { cancelRemoteBrowserActions(); return { invalidated: true }; }
  const account = expectedAccount(command.expectedAccount);
  if (command.operation === 'snapshot') return makeSnapshot(account);
  if (command.operation === 'scroll') {
    assertSafe(account);
    if (!Number.isInteger(command.pixels) || Number(command.pixels) === 0 || Math.abs(Number(command.pixels)) > 2000) fail('INVALID_INPUT');
    invalidate(); globalThis.scrollBy({ top: Number(command.pixels), behavior: 'instant' });
    return makeSnapshot(account);
  }
  if (command.operation === 'prepare') {
    const binding = snapshot;
    if (!binding || binding.id !== command.snapshotId || typeof command.ref !== 'string') fail('REMOTE_BROWSER_STALE');
    assertBinding(binding, account);
    if (typeof command.purpose !== 'string' || !command.purpose.trim() || command.purpose.length > 300 || /[\x00-\x1f\x7f]/.test(command.purpose)) fail('INVALID_INPUT');
    const original = binding.entries.get(command.ref), fresh = original && candidate(original.node);
    if (!original || !fresh || original.fingerprint !== fresh.fingerprint || command.verb !== fresh.descriptor.verb) fail('REMOTE_BROWSER_REF_DENIED');
    let destination: string;
    if (fresh.descriptor.kind === 'navigation') {
      if (command.value !== undefined) fail('INVALID_INPUT');
      destination = fresh.descriptor.url!;
    } else {
      if (typeof command.value !== 'string' || !command.value.trim() || [...command.value].length > 200 || /[\x00-\x1f\x7f]/.test(command.value)) fail('INVALID_INPUT');
      destination = checkedRemoteBrowserUrl(`https://www.threads.com/search?q=${encodeURIComponent(command.value)}&serp_type=default`);
    }
    const token = crypto.randomUUID();
    preparation = { token, binding, candidate: original, destination };
    return { token, account, sourceUrl: checkedRemoteBrowserUrl(binding.route), destination, expiresAt: new Date(binding.expires).toISOString(), kind: fresh.descriptor.kind };
  }
  if (command.operation === 'consume') {
    const current = preparation; preparation = undefined; snapshot = undefined;
    if (!current || current.token !== command.token) fail('REMOTE_BROWSER_PREPARATION_MISSING');
    assertBinding(current.binding, account);
    const fresh = candidate(current.candidate.node);
    if (!fresh || fresh.fingerprint !== current.candidate.fingerprint) fail('REMOTE_BROWSER_STALE');
    const result = { account, sourceUrl: checkedRemoteBrowserUrl(current.binding.route), destination: current.destination,
      kind: current.candidate.descriptor.kind, dispatched: true, verified: false };
    // Keep the final draft/account/route/manual check and this fixed dispatch in
    // one JavaScript turn. A host-side navigate after a bridge round trip would
    // create a window in which a user's new draft could be discarded.
    location.assign(current.destination);
    return result;
  }
  fail('INVALID_COMMAND');
}
