import { assertApprovedMedia } from './media-runtime.js';

export const socialKinds = ['like','unlike','save','unsave','repost','unrepost','follow','unfollow','publish','reply','quote','delete'] as const;
export type SocialKind = typeof socialKinds[number];
export interface SocialRequest { kind: SocialKind; targetUrl: string; text?: string; mediaToken?: string; }
export interface SocialObservation { account: string; url: string; targetUrl: string; state: string; verified: boolean; evidence: string[]; postUrl?: string; }
export interface SocialStage { token: string; account: string; url: string; request: SocialRequest; before: SocialObservation; noop: boolean; }
interface TargetPreview { author: string; timestamp: string; body: string; }
interface Entry extends SocialStage { element?: HTMLElement; fingerprint?: string; scope?: HTMLElement; targetScope?: HTMLElement; editor?: HTMLElement; replyPreview?: { element: HTMLElement; evidence: TargetPreview }; beforeUrls: Set<string>; expires: number; consumed: boolean; committedAt?: number; }
let staged: Entry | undefined;
let generation = 0;
let removeTakeoverWatch: (() => void) | undefined;
let expiryTimer: number | undefined;
export function cancelSocialActions(): void {
  generation++; staged = undefined;
  removeTakeoverWatch?.(); removeTakeoverWatch = undefined;
  if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
  expiryTimer = undefined;
}
function watchManualTakeover(expectedGeneration: number): void {
  const events = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'wheel'];
  const onInteraction = (event: Event) => {
    // HTMLElement.click and our explicitly dispatched input events are synthetic.
    // Real pointer/keyboard input takes ownership before a page handler can close
    // our menu and open an unrelated one with the same action labels.
    if (event.isTrusted && generation === expectedGeneration) cancelSocialActions();
  };
  for (const type of events) document.addEventListener(type, onInteraction, true);
  removeTakeoverWatch = () => { for (const type of events) document.removeEventListener(type, onInteraction, true); };
}
function assertGeneration(expected: number): void {
  if (generation !== expected) fail('ACTION_CANCELLED', 'Browser preparation was cancelled or superseded; no further input was dispatched.');
}
function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
const isVisible = (el: Element): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"], [inert]');
const normalizedName = (value: string | null | undefined) => (value || '').trim().replace(/\s+/g, ' ');
function name(el: Element): string {
  const explicit = normalizedName(el.getAttribute('aria-label'));
  if (explicit) return explicit;
  const iconNames: string[] = [];
  for (const icon of el.querySelectorAll('svg')) {
    // Ignore hidden/decorative or nested-control icons; they cannot label this control.
    if (icon.closest('button,[role="button"],[role="menuitem"],a') !== el || icon.closest('[aria-hidden="true"],[inert]') ||
        !icon.getClientRects().length || getComputedStyle(icon).display === 'none' || getComputedStyle(icon).visibility === 'hidden') continue;
    const aria = normalizedName(icon.getAttribute('aria-label'));
    if (aria) { iconNames.push(aria); continue; }
    const labels = [normalizedName(icon.getAttribute('title')), ...[...icon.children].filter(child => child.localName === 'title').map(child => normalizedName(child.textContent))].filter(Boolean);
    if (new Set(labels).size > 1) return ''; // Conflicting titles are not an actionable name.
    if (labels[0]) iconNames.push(labels[0]);
  }
  if (iconNames.length > 1) return ''; // Multiple labelled icons require explicit control labelling.
  return iconNames[0] || normalizedName((el as HTMLElement).innerText);
}
const controls = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"]')].filter(isVisible);
const fingerprint = (el: HTMLElement) => JSON.stringify([el.tagName, el.getAttribute('role'), name(el), el.getAttribute('aria-pressed'), el.getAttribute('aria-expanded'), el.getAttribute('aria-disabled'), el.innerText]);
const overlays = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="menu"]')].filter(isVisible);
function only<T>(values: T[], message: string, code = 'AMBIGUOUS_UI'): T { if (values.length !== 1) fail(code, message); return values[0]!; }
function account(): string {
  const names = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible)
    .filter(el => /^(Profile|個人檔案)$/i.test(name(el)))
    .map(el => el.pathname.match(/^\/@([\w.]+)\/?$/)?.[1]?.toLowerCase()).filter((x): x is string => !!x);
  return only([...new Set(names)], 'A unique signed-in account must be visible in the profile navigation.', 'AMBIGUOUS_UI_ACCOUNT_NAV');
}
function canonical(value: string): string {
  let url: URL; try { url = new URL(value); } catch { return fail('INVALID_INPUT', 'A full Threads HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || !['threads.com','www.threads.com','threads.net','www.threads.net'].includes(url.hostname) || url.username || url.password || url.port)
    fail('INVALID_INPUT', 'Only canonical Threads HTTPS URLs are allowed.');
  url.hostname = 'www.threads.com'; url.hash = ''; url.search = ''; url.pathname = url.pathname.replace(/\/$/, '') || '/'; return url.href;
}
function requestChecked(request: SocialRequest, inspectOnly = false): SocialRequest {
  if (!socialKinds.includes(request.kind)) fail('INVALID_INPUT', 'Unknown social action.');
  const targetUrl = canonical(request.targetUrl);
  const path = new URL(targetUrl).pathname;
  if (['follow','unfollow'].includes(request.kind) ? !/^\/@[\w.]+$/.test(path) : request.kind === 'publish' ? path !== '/' : !/^\/@[\w.]+\/post\/[\w-]+$/.test(path))
    fail('INVALID_INPUT', 'Use the exact profile/post permalink; publishing requires the Threads home URL.');
  if (['publish','reply','quote'].includes(request.kind)) {
    if (!(inspectOnly && request.text === undefined) && (typeof request.text !== 'string' || !request.text.trim() || Array.from(request.text).length > 500))
      fail('INVALID_INPUT', 'Browser publication requires non-empty text of at most 500 characters.');
  } else if (request.text !== undefined || request.mediaToken !== undefined) fail('INVALID_INPUT', 'Text and approved media are only accepted for publish, reply and quote.');
  if (request.mediaToken !== undefined && (typeof request.mediaToken !== 'string' || !/^[\w-]{1,100}$/.test(request.mediaToken))) fail('INVALID_INPUT', 'An approved media token is required.');
  return { kind: request.kind, targetUrl, ...(request.text !== undefined ? { text: request.text } : {}), ...(request.mediaToken ? { mediaToken: request.mediaToken } : {}) };
}
function context(request: SocialRequest) {
  const url = canonical(location.href);
  if (url !== request.targetUrl) fail('TARGET_CHANGED_ROUTE', 'Navigate to the exact target URL before staging this action.');
  return { url, account: account() };
}
function links(scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLAnchorElement>('a[href*="/post/"]')].filter(isVisible).flatMap(el => {
    try {
      const url = new URL(el.href);
      // Insights, outbound links and malformed URLs are not post identity evidence.
      if (!/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)) return [];
      return [{ el, url: canonical(url.href) }];
    } catch { return []; }
  });
}
function postCard(target: string): HTMLElement {
  const candidates = new Set<HTMLElement>();
  for (const link of links().filter(link => link.url === target)) {
    let node: HTMLElement | null = link.el;
    for (let depth = 0; node && depth < 16; depth++, node = node.parentElement) {
      const reactions = controls(node).filter(el => /^(Like|Unlike|讚|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i.test(name(el)));
      if (reactions.length === 1 && !links(node).some(link => link.url !== target)) { candidates.add(node); break; }
      if (reactions.length > 1) break;
    }
  }
  // A duplicate header permalink may reach an ancestor of the actual card. Keep
  // the smallest isolated card, while separate copies remain ambiguous.
  const isolated = [...candidates].filter(candidate => ![...candidates].some(other => other !== candidate && candidate.contains(other)));
  return only(isolated, 'An isolated post card matching the exact permalink was not uniquely identified.', 'AMBIGUOUS_UI_POST_SCOPE');
}
const matchers: Record<string, RegExp> = {
  like: /^(Like|讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i, unlike: /^(Unlike|收回讚)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i,
  save: /^(Save|儲存|收藏)$/i, unsave: /^(Unsave|Remove from saved|取消儲存|取消收藏)$/i,
  repost: /^(Repost|轉發)$/i, unrepost: /^(Remove repost|Undo repost|移除轉發|取消轉發)$/i,
  follow: /^(Follow|追蹤)$/i, unfollow: /^(Unfollow|Following|取消追蹤|追蹤中)$/i,
  delete: /^(Delete|Delete post|刪除|刪除貼文)$/i,
};
const inverse: Record<string, string> = { like:'unlike',unlike:'like',save:'unsave',unsave:'save',repost:'unrepost',unrepost:'repost',follow:'unfollow',unfollow:'follow' };
function profileScope(request: SocialRequest): HTMLElement {
  const wanted = new URL(request.targetUrl).pathname.slice(2).toLowerCase();
  const scopes = new Set<HTMLElement>();
  for (const heading of [...document.querySelectorAll<HTMLElement>('h1')].filter(isVisible)) {
    if (heading.closest('aside,nav,[role="complementary"],[role="navigation"],[data-pagelet*="timeline"],article')) continue;
    let scope = heading.parentElement;
    for (let depth = 0; scope && depth < 14; depth++, scope = scope.parentElement) {
      const tab = profileTab(request, scope);
      if (!tab || !precedes(heading, tab)) continue;
      const exactHandle = [...scope.querySelectorAll<HTMLElement>('span,div,p')].filter(isVisible)
        .some(el => !el.children.length && normalizedName(el.innerText).replace(/^@/, '').toLowerCase() === wanted && precedes(el, tab));
      const hasSection = [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible)
        .some(el => { try { return [request.targetUrl + '/replies', request.targetUrl + '/media', request.targetUrl + '/reposts'].includes(canonical(el.href)); } catch { return false; } });
      if (exactHandle && hasSection) { scopes.add(scope); break; }
    }
  }
  // Retain explicit semantic headers for layouts that supply them. Do not infer
  // account identity from arbitrary post-author or suggested-profile rows.
  if (!scopes.size) for (const header of [...document.querySelectorAll<HTMLElement>('header,[role="banner"]')].filter(isVisible)) {
    if (header.closest('aside,nav,[role="complementary"],[role="navigation"],article,[data-pagelet*="timeline"]')) continue;
    if ([...header.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible).some(a => { try { return canonical(a.href) === request.targetUrl; } catch { return false; } })) scopes.add(header);
  }
  // A sticky column title can reach an ancestor containing the same complete
  // profile. Keep the smallest independently identified profile; separate copies
  // remain ambiguous instead of letting a column heading widen the action scope.
  const isolated = [...scopes].filter(candidate => ![...scopes].some(other => other !== candidate && candidate.contains(other)));
  return only(isolated, 'A unique profile heading, exact username and matching profile tabs are required; suggested profiles and post rows are excluded.', 'AMBIGUOUS_UI_PROFILE_SCOPE');
}
function precedes(first: Node, second: Node) { return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING); }
function profileTab(request: SocialRequest, scope: HTMLElement): HTMLAnchorElement | undefined {
  const tabs = [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible).filter(el => {
    try { return canonical(el.href) === request.targetUrl && (el.getAttribute('aria-current') === 'page' || /^(Threads|Posts|串文|貼文)$/i.test(name(el))); } catch { return false; }
  });
  return tabs.length === 1 ? tabs[0] : undefined;
}
function actionControls(request: SocialRequest, scope: HTMLElement): HTMLElement[] {
  const found = controls(scope);
  if (!['follow','unfollow'].includes(request.kind)) return found;
  const tab = profileTab(request, scope);
  return found.filter(el => !el.closest('aside,nav,[role="complementary"],[role="navigation"],article,[data-pagelet*="timeline"]') && (!tab || precedes(el, tab)));
}
function assertOwnPost(request: SocialRequest, card: HTMLElement, expectedAccount: string): void {
  const author = new URL(request.targetUrl).pathname.match(/^\/@([\w.]+)\/post\//)?.[1]?.toLowerCase();
  const profile = `https://www.threads.com/@${expectedAccount}`;
  const authorLinks = [...card.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible).filter(link => {
    try { return canonical(link.href) === profile; } catch { return false; }
  });
  if (author !== expectedAccount || !authorLinks.length) fail('OWN_POST_REQUIRED', 'Deletion requires the exact current-account post permalink and a visible matching author profile link in that post card.');
}
function currentState(request: SocialRequest, scope: HTMLElement): string {
  const buttons = actionControls(request, scope);
  if (['follow','unfollow'].includes(request.kind)) {
    const following = buttons.filter(el => /^(Following|追蹤中|Unfollow|取消追蹤)$/i.test(name(el)));
    const follow = buttons.filter(el => matchers.follow!.test(name(el)));
    const requested = buttons.filter(el => /^(Requested|已發送邀請|已要求追蹤)$/i.test(name(el)));
    if (following.length === 1 && !follow.length && !requested.length) return 'unfollow';
    if (requested.length === 1 && !following.length && !follow.length) return 'follow-requested';
    if (following.length + follow.length + requested.length !== 1) return 'unknown';
  }
  const own = buttons.filter(el => matchers[request.kind]?.test(name(el)));
  const opposite = buttons.filter(el => matchers[inverse[request.kind]!]?.test(name(el)));
  if (own.length === 1 && opposite.length === 0) return request.kind;
  if (opposite.length === 1 && own.length === 0) return inverse[request.kind]!;
  return 'unknown';
}
function observation(request: SocialRequest, scope?: HTMLElement, observedContext?: { url: string; account: string }): SocialObservation {
  const ctx = observedContext ?? context(request); const state = scope ? currentState(request, scope) : 'unknown';
  return { ...ctx, targetUrl: request.targetUrl, state, verified: state === inverse[request.kind], evidence: scope ? ['Unique exact-target DOM scope', 'Visible action label identifies the current toggle state'] : [] };
}
async function waitFor<T>(read: () => T | undefined, code = 'UI_NOT_READY'): Promise<T> {
  for (let i = 0; i < 8; i++) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  return fail(code, 'The expected unique UI did not appear; inspect it before another preparation.');
}
async function settledMenuTarget(request: SocialRequest, pattern: RegExp, expectedGeneration: number, expectedAccount: string): Promise<{ card: HTMLElement; opener: HTMLElement }> {
  let previousCard: HTMLElement | undefined; let previousOpener: HTMLElement | undefined; let previousFingerprint = '';
  let quietSince = Date.now(); let observer: MutationObserver | undefined;
  const deadline = Date.now() + 8000;
  try {
    while (Date.now() < deadline) {
      assertGeneration(expectedGeneration);
      if (context(request).account !== expectedAccount) fail('ACCOUNT_MISMATCH', 'The account changed while waiting for the target post to settle.');
      if (overlays().length) fail('EXISTING_OVERLAY', 'A menu or dialog appeared before the target post settled.');
      try {
        const card = postCard(request.targetUrl);
        if (request.kind === 'delete') assertOwnPost(request, card, expectedAccount);
        const opener = only(controls(card).filter(el => pattern.test(name(el)) && /^(true|menu|dialog)$/.test(el.getAttribute('aria-haspopup') || '')), 'An explicit, unique menu trigger is required for this action.', 'AMBIGUOUS_UI_MENU_TRIGGER');
        const mark = fingerprint(opener);
        if (card !== previousCard || opener !== previousOpener || mark !== previousFingerprint) {
          observer?.disconnect(); quietSince = Date.now();
          previousCard = card; previousOpener = opener; previousFingerprint = mark;
          observer = new MutationObserver(() => { quietSince = Date.now(); });
          observer.observe(card, { subtree: true, childList: true, characterData: true, attributes: true });
        }
        const loading = [card, ...card.querySelectorAll('[role="progressbar"],[aria-busy="true"],[aria-label]')].filter(isVisible)
          .some(el => el.getAttribute('role') === 'progressbar' || el.getAttribute('aria-busy') === 'true' || /^(Loading|載入中)(?:\.{3}|…)?$/i.test(el.getAttribute('aria-label') || ''));
        if (loading || opener.matches(':disabled,[aria-disabled="true"]')) quietSince = Date.now();
        else if (Date.now() - quietSince >= 600) return { card, opener };
      } catch (error) {
        if (!/^AMBIGUOUS_UI_(POST_SCOPE|MENU_TRIGGER):/.test(String((error as Error).message))) throw error;
        observer?.disconnect(); observer = undefined; previousCard = undefined; previousOpener = undefined; quietSince = Date.now();
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return fail('UI_NOT_READY_MENU_TARGET', 'The exact post and its unique menu trigger did not settle before the preparation deadline. No menu click was dispatched.');
  } finally { observer?.disconnect(); }
}
async function menuFor(request: SocialRequest, expectedGeneration: number): Promise<{ menu: HTMLElement; card: HTMLElement }> {
  assertGeneration(expectedGeneration);
  const expectedAccount = context(request).account;
  if (overlays().length) fail('EXISTING_OVERLAY', 'Close the existing menu/dialog before staging another social action.');
  const pattern = ['repost','unrepost','quote'].includes(request.kind) ? /^(Repost|轉發)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i : /^(More|More options|更多|更多選項)$/i;
  const { card, opener } = await settledMenuTarget(request, pattern, expectedGeneration, expectedAccount);
  assertGeneration(expectedGeneration);
  if (context(request).account !== expectedAccount) fail('ACCOUNT_MISMATCH', 'The account changed before opening its action menu.');
  if (overlays().length) fail('EXISTING_OVERLAY', 'A menu or dialog appeared before the prepared menu click.');
  if (!card.isConnected || postCard(request.targetUrl) !== card) fail('TARGET_CHANGED_MENU_CARD', 'The settled exact post changed before its menu was opened.');
  if (request.kind === 'delete') assertOwnPost(request, card, expectedAccount);
  if (!isVisible(opener) || !card.contains(opener) || !pattern.test(name(opener))) fail('TARGET_CHANGED_MENU_TRIGGER', 'The settled menu trigger changed before it was opened.');
  opener.click();
  // React may replace the first overlay shell while mounting its action rows.
  // Select the final populated menu inside the wait, keeping its original card
  // and trigger bound throughout; never click again or rebind another post.
  const menu = await waitFor(() => {
    assertGeneration(expectedGeneration);
    if (context(request).account !== expectedAccount) fail('ACCOUNT_MISMATCH', 'The account changed while opening its action menu.');
    if (!card.isConnected) fail('TARGET_CHANGED_MENU_CARD', 'The original post card was removed while opening its action menu.');
    if (!opener.isConnected || !card.contains(opener)) fail('TARGET_CHANGED_MENU_TRIGGER', 'The original menu trigger was removed from its post card.');
    const found = overlays();
    if (found.length !== 1) return;
    const candidate = found[0]!;
    const controlledId = opener.getAttribute('aria-controls');
    if (controlledId && !controlledId.split(/\s+/).includes(candidate.id)) return;
    const ready = request.kind === 'quote'
      ? controls(candidate).filter(el => /^(Quote|Quote post|引用|引用貼文)$/i.test(name(el))).length === 1
      : currentState(request, candidate) !== 'unknown';
    return ready ? candidate : undefined;
  }, 'AMBIGUOUS_UI_MENU_CONTENT');
  assertGeneration(expectedGeneration);
  context(request); if (!card.isConnected) fail('TARGET_CHANGED_MENU_CARD', 'The target card changed while opening its menu.');
  return { menu, card };
}
function editorValue(editor: HTMLElement) { return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText; }
function editors(scope: ParentNode) { return [...scope.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"][role="textbox"],[contenteditable="true"][data-lexical-editor="true"]')].filter(isVisible); }
function attachmentScope(scope: HTMLElement, editor?: HTMLElement): HTMLElement {
  const body = editor?.closest<HTMLElement>('[data-barcelona-composer-body="true"]');
  return body && scope.contains(body) ? body : scope;
}
function hasAttachments(scope: HTMLElement, editor?: HTMLElement): boolean {
  scope = attachmentScope(scope, editor);
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(input => !!input.files?.length) || !!scope.querySelector('video,img[src^="blob:"]') ||
    [...scope.querySelectorAll('[aria-label]')].some(el => /^(Remove|Delete|移除|刪除)\s*(media|image|photo|video|attachment|圖片|相片|影片|附件)/i.test(el.getAttribute('aria-label') || ''));
}
function bodyText(scope: HTMLElement): string {
  return [...scope.querySelectorAll<HTMLElement>('[dir="auto"],p')].filter(isVisible)
    .filter(el => !el.closest('a,button,[role="button"],time,svg,[contenteditable],h1,h2') && !el.querySelector('[dir="auto"],p,button,[role="button"],time,[contenteditable],a[href^="/@"]'))
    .map(el => normalizedName(el.innerText)).filter(Boolean).join(' ');
}
function targetEvidence(scope: HTMLElement, targetUrl: string): TargetPreview | undefined {
  const author = new URL(targetUrl).pathname.match(/^\/@([\w.]+)\/post\//)?.[1]?.toLowerCase();
  const timestamps = [...scope.querySelectorAll<HTMLElement>('time[datetime]')].filter(isVisible).map(el => el.getAttribute('datetime')!);
  const body = bodyText(scope);
  if (!author || timestamps.length !== 1 || !Number.isFinite(Date.parse(timestamps[0]!)) || !body) return;
  if (![...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isVisible).some(el => { try { return canonical(el.href) === `https://www.threads.com/@${author}`; } catch { return false; } })) return;
  return { author, timestamp: timestamps[0]!, body };
}
function matchingReplyPreview(scope: HTMLElement, editor: HTMLElement, targetUrl: string, expected?: TargetPreview): HTMLElement | undefined {
  if (!expected || ![...scope.querySelectorAll('h1,h2,[role="heading"]')].some(el => /^(Reply|回覆)$/i.test(normalizedName(el.textContent)))) return;
  const found = new Set<HTMLElement>();
  for (const time of [...scope.querySelectorAll<HTMLElement>('time[datetime]')].filter(isVisible)) {
    if (time.getAttribute('datetime') !== expected.timestamp || !precedes(time, editor)) continue;
    let node = time.parentElement;
    while (node && scope.contains(node) && !node.contains(editor)) {
      const evidence = targetEvidence(node, targetUrl);
      if (evidence && JSON.stringify(evidence) === JSON.stringify(expected)) { found.add(node); break; }
      node = node.parentElement;
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}
function textMatches(card: HTMLElement, text: string): boolean {
  // Exact visible text node grouping; no substring match that could accept an old or different post.
  return [...card.querySelectorAll<HTMLElement>('p,[dir="auto"]')].filter(isVisible).some(el => el.innerText.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n'));
}
export async function socialStage(input: SocialRequest): Promise<SocialStage> {
  const request = requestChecked(input); const ctx = context(request);
  cancelSocialActions();
  const expectedGeneration = generation;
  watchManualTakeover(expectedGeneration);
  try {
  const beforeUrls = new Set(links().map(link => link.url));
  let scope: HTMLElement; let targetScope: HTMLElement | undefined; let element: HTMLElement | undefined; let editor: HTMLElement | undefined;
  let expectedReply: TargetPreview | undefined; let replyPreview: Entry['replyPreview'];
  const isCompose = ['publish','reply','quote'].includes(request.kind);
  if (isCompose) {
    if (request.mediaToken) {
      scope = only(overlays().filter(el => el.getAttribute('role') === 'dialog'), 'Approved media must be in exactly one composer dialog.');
      assertApprovedMedia(request.mediaToken, scope);
    } else {
      if (overlays().length || editors(document).some(el => editorValue(el).trim())) fail('EXISTING_DRAFT', 'An existing draft or dialog is present; leave it intact and resolve it manually.');
      if (request.kind === 'publish') {
      only(controls(document).filter(el => /^(Create|New thread|新增|建立|新串文)$/i.test(name(el))), 'A unique new-thread control is required.').click();
      } else {
      const card = postCard(request.targetUrl); targetScope = card;
      if (request.kind === 'reply') expectedReply = targetEvidence(card, request.targetUrl);
      if (request.kind === 'reply') only(controls(card).filter(el => /^(Reply|Replied|回覆|已回覆)(?:\s*\d[\d.,]*(?:\s*[萬万億KMB])?)?$/i.test(name(el))), 'A unique Reply control in the exact target post is required.').click();
      else {
        const binding = await menuFor(request, expectedGeneration); targetScope = binding.card;
        const menu = binding.menu;
        assertGeneration(expectedGeneration);
        only(controls(menu).filter(el => /^(Quote|Quote post|引用|引用貼文)$/i.test(name(el))), 'A unique Quote menu action is required.').click();
      }
      }
      scope = await waitFor(() => { assertGeneration(expectedGeneration); const ds = overlays().filter(el => el.getAttribute('role') === 'dialog' && editors(el).length === 1); return ds.length === 1 ? ds[0] : undefined; });
    }
    assertGeneration(expectedGeneration);
    context(request); editor = only(editors(scope), 'The composer needs exactly one text editor.');
    if (editorValue(editor).trim()) fail('EXISTING_DRAFT', 'The opened composer contains a draft; it was not replaced.');
    if (request.kind !== 'publish' && !links(scope).some(link => link.url === request.targetUrl)) {
      const preview = request.kind === 'reply' ? matchingReplyPreview(scope, editor, request.targetUrl, expectedReply) : undefined;
      if (!preview || !expectedReply) fail('TARGET_UNVERIFIED', 'The composer needs an exact target permalink or a reply preview matching the source author, timestamp and complete visible body.');
      replyPreview = { element: preview, evidence: expectedReply };
    }
    if (!request.mediaToken && hasAttachments(scope, editor)) fail('EXISTING_MEDIA', 'Existing composer media was not authorized.');
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, request.text!);
    else editor.textContent = request.text!;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: request.text! }));
    element = await waitFor(() => { assertGeneration(expectedGeneration); const bs = controls(scope).filter(el => /^(Post|Publish|Reply|發佈|發布|回覆)$/i.test(name(el)) && !el.matches(':disabled,[aria-disabled="true"]')); return bs.length === 1 ? bs[0] : undefined; });
    assertGeneration(expectedGeneration);
    if (editorValue(editor) !== request.text) fail('DRAFT_NOT_ACCEPTED', 'The composer did not retain the exact requested text.');
  } else {
    if (overlays().length) fail('EXISTING_OVERLAY', 'Close the existing menu/dialog before staging a social action.');
    scope = ['follow','unfollow'].includes(request.kind) ? profileScope(request) : postCard(request.targetUrl); targetScope = scope;
    if (request.kind === 'delete') assertOwnPost(request, scope, ctx.account);
    const needsMenu = ['save','unsave','repost','unrepost','delete'].includes(request.kind);
    if (needsMenu) { const binding = await menuFor(request, expectedGeneration); scope = binding.menu; targetScope = binding.card; }
    assertGeneration(expectedGeneration);
    const state = currentState(request, scope);
    if (state === 'unknown') fail('AMBIGUOUS_UI_ACTION_STATE', 'The exact target has conflicting or unknown action state; no action was staged.');
    if (state !== inverse[request.kind]) element = only(actionControls(request, scope).filter(el => matchers[request.kind]!.test(name(el))), 'The exact desired action is not uniquely available. No toggle was dispatched.', 'AMBIGUOUS_UI_ACTION_CONTROL');
  }
  assertGeneration(expectedGeneration);
  const before = observation(request, scope);
  const entry: Entry = { token: crypto.randomUUID(), ...ctx, request, before, noop: !isCompose && before.verified,
    element, fingerprint: element ? fingerprint(element) : undefined, scope, targetScope, editor, replyPreview, beforeUrls, expires: Date.now() + 90_000, consumed: false };
  staged = entry;
  expiryTimer = window.setTimeout(() => { if (generation === expectedGeneration) cancelSocialActions(); }, Math.max(0, entry.expires - Date.now()));
  return { token: entry.token, account: entry.account, url: entry.url, request, before, noop: entry.noop };
  } catch (error) {
    if (generation === expectedGeneration) cancelSocialActions();
    throw error;
  }
}
export function socialCommit(token: string, expectedAccount: string): { dispatched: boolean; noop: boolean } {
  const entry = staged;
  if (!entry || entry.token !== token || entry.consumed) fail('INVALID_ACTION', 'The browser preparation is absent or consumed.');
  entry.consumed = true;
  if (Date.now() > entry.expires) fail('EXPIRED_ACTION', 'Prepare from current UI again.');
  const ctx = context(entry.request);
  if (ctx.account !== entry.account || expectedAccount.replace(/^@/, '').toLowerCase() !== entry.account) fail('ACCOUNT_MISMATCH', 'The signed-in account changed.');
  if (!entry.scope?.isConnected || !isVisible(entry.scope)) fail('TARGET_CHANGED', 'The staged UI scope changed.');
  if (overlays().some(overlay => overlay !== entry.scope)) fail('UI_CHANGED', 'Another dialog or menu opened after preparation.');
  if (entry.targetScope && !entry.editor) {
    const target = ['follow','unfollow'].includes(entry.request.kind) ? profileScope(entry.request) : postCard(entry.request.targetUrl);
    if (target !== entry.targetScope) fail('TARGET_CHANGED', 'The exact target card or header changed after staging.');
    if (entry.request.kind === 'delete') assertOwnPost(entry.request, target, entry.account);
  }
  if (entry.noop) {
    if (!observation(entry.request, entry.scope).verified) fail('STATE_CHANGED', 'The desired state changed since preparation.');
    return { dispatched: false, noop: true };
  }
  const el = entry.element!;
  if (!isVisible(el) || !entry.scope.contains(el) || fingerprint(el) !== entry.fingerprint || el.matches(':disabled,[aria-disabled="true"]')) fail('STALE_ELEMENT', 'The staged control changed; no input was dispatched.');
  if (entry.editor && (!isVisible(entry.editor) || !entry.scope.contains(entry.editor) || editorValue(entry.editor) !== entry.request.text)) fail('DRAFT_CHANGED', 'The exact staged draft changed.');
  if (entry.editor) {
    if (entry.request.mediaToken) assertApprovedMedia(entry.request.mediaToken, entry.scope);
    else if (hasAttachments(entry.scope, entry.editor)) fail('MEDIA_CHANGED', 'Unexpected composer media appeared after preparation.');
  }
  if (entry.editor && entry.request.kind !== 'publish' && !links(entry.scope).some(link => link.url === entry.request.targetUrl)) {
    if (!entry.targetScope?.isConnected || !entry.replyPreview || matchingReplyPreview(entry.scope, entry.editor, entry.request.targetUrl, entry.replyPreview.evidence) !== entry.replyPreview.element)
      fail('TARGET_CHANGED', 'The composer target preview changed after preparation.');
  }
  entry.committedAt = Date.now(); el.click(); return { dispatched: true, noop: false };
}
export async function socialInspect(input: SocialRequest, token?: string): Promise<SocialObservation> {
  const expectedGeneration = generation;
  const inspected = requestChecked(input, true);
  const entry = staged && staged.token === token && staged.consumed && staged.request.kind === inspected.kind && staged.request.targetUrl === inspected.targetUrl ? staged : undefined;
  if (token !== undefined && !entry) fail('ACTION_CANCELLED', 'The committed action evidence was cancelled or is unavailable; inspect without a token only for an unattributed current-state observation.');
  const request = entry?.request ?? inspected;
  const ctx = { url: canonical(location.href), account: account() };
  if (entry && ctx.account !== entry.account) fail('ACCOUNT_MISMATCH', 'The account changed after dispatch.');
  if (ctx.url !== request.targetUrl) {
    const ownNewPostRoute = !!entry?.committedAt && ['publish','reply','quote'].includes(request.kind) && !entry.beforeUrls.has(ctx.url) &&
      new URL(ctx.url).pathname.startsWith(`/@${ctx.account}/post/`) && /^\/@[\w.]+\/post\/[\w-]+$/.test(new URL(ctx.url).pathname);
    if (!ownNewPostRoute) fail('TARGET_CHANGED', 'The current page is neither the prepared target nor a new own-post route after commit.');
  }
  if (['publish','reply','quote'].includes(request.kind)) {
    const result = observation(request, undefined, ctx);
    if (!entry) return result;
    const newLinks = [...new Set(links().map(link => link.url))].filter(url => !entry.beforeUrls.has(url) && new URL(url).pathname.startsWith(`/@${ctx.account}/post/`));
    const matches = newLinks.filter(url => { try {
      const card = postCard(url); const timestamp = card.querySelector('time[datetime]')?.getAttribute('datetime');
      const created = timestamp ? Date.parse(timestamp) : NaN;
      return textMatches(card, request.text!) && !!entry.committedAt && Number.isFinite(created) && created >= entry.committedAt - 2000 && created <= Date.now() + 2000;
    } catch { return false; } });
    // A visible new post proves publication only. Reply/quote relation is not inferred from the current route.
    if (request.kind === 'publish' && !request.mediaToken && matches.length === 1) return { ...result, state: 'published', verified: true, postUrl: matches[0], evidence: ['New visible permalink absent before commit', 'Exact current account author', 'Exact visible submitted text', 'Visible creation timestamp within the commit window'] };
    if (request.mediaToken && matches.length === 1) return { ...result, state: 'publication-observed-media-unverified', postUrl: matches[0], evidence: ['New exact-text post observed, but uploaded media bytes cannot be matched to the rendered remote attachments'] };
    return { ...result, state: matches.length ? 'new-post-observed-relation-unverified' : 'publication-unverified', evidence: matches.length ? ['New exact-text post observed, but reply/quote relationship is not established'] : [] };
  }
  if (request.kind === 'delete') {
    if (entry && overlays().some(overlay => overlay !== entry.scope)) return { ...ctx, targetUrl: request.targetUrl, state: 'confirmation-required', verified: false,
      evidence: ['The exact own-post Delete menu item was dispatched once', 'A new dialog or menu is visible; no confirmation was clicked'] };
    let card: HTMLElement | undefined;
    try { card = postCard(request.targetUrl); } catch (error) {
      if (!entry) throw error;
    }
    if (card) assertOwnPost(request, card, ctx.account);
    return { ...ctx, targetUrl: request.targetUrl, state: card ? 'own-post-observed' : 'deletion-unverified', verified: false,
      evidence: card ? ['The exact own-account post remains visible'] : ['The target post is no longer visible; absence alone does not prove deletion'] };
  }
  let scope = ['follow','unfollow'].includes(request.kind) ? profileScope(request) : postCard(request.targetUrl);
  if (entry && request.kind === 'unfollow' && overlays().length) return { ...observation(request, scope), verified: false, state: 'confirmation-required', evidence: ['The authorized Following/Unfollow control was dispatched once', 'A dialog or menu is now visible; its confirmation has not been dispatched'] };
  if (['save','unsave','repost','unrepost'].includes(request.kind)) {
    if (entry?.scope && isVisible(entry.scope)) scope = entry.scope;
    else if (entry) { scope = (await menuFor(request, expectedGeneration)).menu; assertGeneration(expectedGeneration); entry.scope = scope; }
    else return { ...ctx, targetUrl: request.targetUrl, state: 'menu-required', verified: false, evidence: [] };
  }
  return observation(request, scope);
}
