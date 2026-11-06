import { normalizeProfile, parsePayloads, parseWire } from './parser.js';
import type { DirectProfileArgs, DirectProfileResult, DirectProfileStopReason } from './direct-profile-types.js';

type Obj = Record<string, any>;
type Context = { viewer: () => string | null; guard: () => void };
const active = new Set<AbortController>();
const queryName = 'BarcelonaProfileThreadsTabRefetchableDirectQuery';
const totalBudgetMs = 45_000;

class DirectFailure extends Error {
  constructor(readonly reason: DirectProfileStopReason) { super(`DIRECT_PROFILE_${reason.toUpperCase()}`); }
}
function fail(reason: DirectProfileStopReason): never { throw new DirectFailure(reason); }
function numericId(value: unknown): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^\d+$/.test(text) ? text : null;
}

/** Invalidate in-flight reads when the extension disconnects or the controlling action changes. */
export function cancelDirectProfiles(): void {
  for (const controller of active) controller.abort(new DirectFailure('cancelled'));
}

/** A bounded public-profile connection reader. Session fields and cursors never leave this function. */
export async function directProfile(
  args: DirectProfileArgs, context: Context,
): Promise<DirectProfileResult> {
  const { username, maxPages } = args, pageSize = args.pageSize ?? 10;
  if (!/^[\w.]{1,64}$/.test(username) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new Error('DIRECT_PROFILE_INVALID_INPUT');
  const route = location.href, viewer = context.viewer(), started = Date.now();
  const url = new URL(route);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['www.threads.com', 'threads.com'].includes(url.hostname) ||
      url.pathname !== `/@${username}` && url.pathname !== `/@${username}/` || !viewer) fail('binding_unavailable');
  const queryUrl = new URL('/graphql/query', url.origin).href;
  const controller = new AbortController();
  active.add(controller);
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason instanceof DirectFailure ? controller.signal.reason : new DirectFailure('cancelled');
    if (Date.now() - started >= totalBudgetMs) fail('time_limit');
    if (location.href !== route || context.viewer() !== viewer) fail('context_changed');
    try { context.guard(); } catch { fail('context_changed'); }
  };
  const onManual = (event: Event) => { if (event.isTrusted) controller.abort(new DirectFailure('context_changed')); };
  const onNavigation = () => controller.abort(new DirectFailure('context_changed'));
  for (const type of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, onManual, true);
  for (const type of ['pagehide', 'beforeunload']) globalThis.addEventListener(type, onNavigation);
  const watch = setInterval(() => { try { check(); } catch (error) { controller.abort(error); } }, 100);
  const deadline = setTimeout(() => controller.abort(new DirectFailure('time_limit')), totalBudgetMs);
  const observedAt = new Date().toISOString();
  const result: DirectProfileResult = {
    profile: null, items: [], contextualPosts: [], sourceUrl: route, observedAt, completeness: 'partial', warnings: [],
    pagination: { provider: 'direct', pagesFetched: 0, requests: 0, uniquePosts: 0, hasNext: null, stopReason: 'page_limit', pages: [] },
  };
  const readText = async (requestUrl: string, options: RequestInit, cap: number, timeout: number) => {
    check();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(timeout, totalBudgetMs - (Date.now() - started)))]);
    let response: Response;
    try { response = await fetch(requestUrl, { ...options, redirect: 'error', signal }); }
    catch { check(); fail('request_failed'); }
    check();
    if (!response.ok) { await response.body?.cancel(); fail('http_rejected'); }
    if (!response.body) fail('schema_unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      while (true) {
        const part = await reader.read();
        check();
        if (part.done) break;
        size += part.value.length;
        if (size > cap) fail('response_limit');
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      check();
      if (error instanceof DirectFailure) throw error;
      fail('request_failed');
    } finally { reader.releaseLock(); }
  };
  try {
    check();
    const profiles: Obj[] = [], variables: Obj[] = [], connections: Obj[] = [];
    let lsd: string | undefined, dtsg: string | undefined, csrf: string | undefined, bloks: string | undefined;
    let nodes = 0, bootstrapBytes = 0;
    const walk = (value: any, depth = 0): void => {
      if (!value || typeof value !== 'object') return;
      if (++nodes > 150_000 || depth > 40) fail('response_limit');
      if (value.username === username && numericId(value.pk ?? value.id)) profiles.push(value);
      if (value.variables?.userID && typeof value.variables.first === 'number') variables.push(value.variables);
      if (value.mediaData?.page_info && Array.isArray(value.mediaData.edges)) connections.push(value.mediaData);
      if (Array.isArray(value)) {
        if (value[0] === 'LSD' && typeof value[2]?.token === 'string') lsd = value[2].token;
        if (value[0] === 'DTSGInitialData' && typeof value[2]?.token === 'string') dtsg = value[2].token;
        if (value[0] === 'InstagramSecurityConfig' && typeof value[2]?.csrf_token === 'string') csrf = value[2].csrf_token;
        if (value[0] === 'WebBloksVersioningID' && typeof value[2]?.versioningID === 'string') bloks = value[2].versioningID;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent ?? '';
      bootstrapBytes += text.length;
      if (bootstrapBytes > 12_000_000) fail('response_limit');
      for (const payload of parseWire(text)) walk(payload);
    }
    const ids = new Set(profiles.map(profile => numericId(profile.pk ?? profile.id)));
    const privacy = profiles.map(profile => profile.text_post_app_is_private).filter(value => typeof value === 'boolean');
    if (ids.size !== 1 || !privacy.length || privacy.some(Boolean)) fail('binding_unavailable');
    const targetId = [...ids][0]!;
    const boundVariables = variables.filter(value => numericId(value.userID) === targetId);
    const boundConnections = connections.filter(value => value.edges.length > 0 && value.edges.every((edge: Obj) => edge.node?.thread_items?.[0]?.post?.user?.username === username));
    if (boundVariables.length !== 1 || boundConnections.length !== 1) fail('binding_unavailable');
    result.profile = normalizeProfile(profiles.find(profile => profile.text_post_app_is_private === false));
    const knownIds = new Set<string>(), knownCodes = new Set<string>(), cursors = new Set<string>();
    let cursor: string | null = null;
    const acceptPage = (connection: Obj, initial: boolean): void => {
      if (!Array.isArray(connection.edges) || connection.edges.length > (initial ? 100 : pageSize) || !connection.page_info ||
          typeof connection.page_info.has_next_page !== 'boolean') fail('schema_unavailable');
      const rawPosts = connection.edges.map((edge: Obj) => edge.node?.thread_items?.[0]?.post);
      for (const post of rawPosts) {
        if (!post || !numericId(post.pk ?? post.id) || post.user?.username !== username ||
            numericId(post.user.pk ?? post.user.id) !== targetId || typeof post.code !== 'string' || !/^[\w-]+$/.test(post.code)) fail('binding_unavailable');
      }
      const allowedIds = new Set(rawPosts.map((post: Obj) => numericId(post.pk ?? post.id)!));
      const parsed = parsePayloads(rawPosts, { source: 'profile-direct', observedAt });
      const normalized = parsed.posts.filter(post => allowedIds.has(post.id) && post.author.username === username);
      if (new Set(normalized.map(post => post.id)).size !== allowedIds.size || parsed.warnings.length) fail('schema_unavailable');
      let added = 0;
      for (const post of normalized) {
        if (knownIds.has(post.id) || knownCodes.has(post.code!)) continue;
        knownIds.add(post.id); knownCodes.add(post.code!); result.items.push(post); added++;
      }
      const next = typeof connection.page_info.end_cursor === 'string' && connection.page_info.end_cursor.length > 0 ? connection.page_info.end_cursor : null;
      const advanced = initial ? null : next !== null && next !== cursor;
      result.pagination.pagesFetched++;
      result.pagination.pages.push({ page: result.pagination.pagesFetched, received: rawPosts.length, added, cursorAdvanced: advanced });
      result.pagination.uniquePosts = result.items.length;
      result.pagination.hasNext = connection.page_info.has_next_page;
      if (!result.pagination.hasNext) result.pagination.stopReason = 'end_of_connection';
      else if (!next) result.pagination.stopReason = 'cursor_missing';
      else if (cursors.has(next)) result.pagination.stopReason = 'cursor_loop';
      else if (!initial && !added) result.pagination.stopReason = 'no_progress';
      else result.pagination.stopReason = 'page_limit';
      if (next) cursors.add(next);
      cursor = next;
    };
    acceptPage(boundConnections[0]!, true);
    if (maxPages === 1 || result.pagination.stopReason !== 'page_limit') return result;
    if (!lsd || !dtsg || !csrf) fail('binding_unavailable');

    let docId: string | undefined, artifact: string | undefined, staticBytes = 0;
    const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => script.src).filter(src => {
      try { const u = new URL(src); return u.protocol === 'https:' && !u.username && !u.password && /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname); } catch { return false; }
    });
    for (const src of [...new Set(scripts)].slice(0, 50)) {
      check();
      let text: string;
      try { text = await readText(src, { credentials: 'omit' }, 5_000_000, 2000); }
      catch (error) {
        if (error instanceof DirectFailure && ['http_rejected', 'request_failed'].includes(error.reason)) continue;
        throw error;
      }
      staticBytes += text.length;
      if (staticBytes > 15_000_000) fail('response_limit');
      const match = /__d\("BarcelonaProfileThreadsTabRefetchableDirectQuery_threadsRelayOperation",\[\],[\s\S]{0,130}?\.exports="(\d{10,30})"/.exec(text);
      if (match) docId = match[1];
      const start = text.indexOf(`__d("${queryName}.threads.graphql"`);
      if (start >= 0) { const end = text.indexOf('__d(', start + 4); artifact = text.slice(start, end < 0 ? undefined : end); }
      if (docId && artifact) break;
    }
    if (!docId || !artifact?.includes('operationKind:"query"') || !artifact.includes(`name:"${queryName}"`)) fail('query_unavailable');
    const flags = [...new Set(artifact.match(/__relay_internal__pv__[A-Za-z0-9_]+/g) ?? [])];
    const currentVariables = boundVariables[0]!;
    if (flags.some(key => typeof currentVariables[key] !== 'boolean')) fail('binding_unavailable');
    while (result.pagination.pagesFetched < maxPages && result.pagination.stopReason === 'page_limit') {
      check();
      const nextVariables = { ...Object.fromEntries(flags.map(key => [key, currentVariables[key]])), userID: targetId,
        first: pageSize, after: cursor, before: null, last: null, allow_page_info_for_lox_user: currentVariables.allow_page_info_for_lox_user };
      const body = new URLSearchParams({ __a: '1', fb_dtsg: dtsg, lsd, fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: queryName, doc_id: docId, variables: JSON.stringify(nextVariables), server_timestamps: 'true' });
      result.pagination.requests++;
      const text = await readText(queryUrl, { method: 'POST', credentials: 'same-origin', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', 'X-FB-LSD': lsd, 'X-CSRFToken': csrf,
        'X-IG-App-ID': '238260118697367', ...(bloks ? { 'X-BLOKS-VERSION-ID': bloks } : {}),
      }, body }, 3_000_000, 12_000);
      const payloads = parseWire(text) as Obj[];
      if (payloads.some(payload => Array.isArray(payload.errors) && payload.errors.length)) fail('graphql_error');
      const pages = payloads.filter(payload => payload.data?.mediaData).map(payload => payload.data.mediaData);
      if (pages.length !== 1) fail('schema_unavailable');
      check();
      acceptPage(pages[0]!, false);
    }
    return result;
  } catch (error) {
    const reason = error instanceof DirectFailure ? error.reason : 'request_failed';
    if (!result.pagination.pagesFetched || reason === 'context_changed' || reason === 'cancelled') throw new DirectFailure(reason);
    result.pagination.stopReason = reason;
    result.warnings.push(`Direct profile pagination stopped: ${reason}. Results cover only accepted pages.`);
    return result;
  } finally {
    clearInterval(watch); clearTimeout(deadline); active.delete(controller);
    controller.abort(); // Also release a response whose context changed before its reader was acquired.
    for (const type of ['pointerdown', 'keydown', 'touchstart']) document.removeEventListener(type, onManual, true);
    for (const type of ['pagehide', 'beforeunload']) globalThis.removeEventListener(type, onNavigation);
  }
}
