import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import type { SocialRequest, SocialStage } from './social-actions.js';
import { sameThreadsRoute } from './service.js';
import { handle } from './urls.js';
import { ThreadsError } from './types.js';

export const REMOTE_SOCIAL_KINDS = ['like','unlike','save','unsave','repost','unrepost','follow','unfollow','publish','reply','quote'] as const;
const publication = (kind: string) => ['publish','reply','quote'].includes(kind);
function invalid(): never { throw new ThreadsError('INVALID_INPUT', 'Use an approved social action with its exact target and supported fields.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid();
}
export function remoteAccount(value: unknown): string {
  if (typeof value !== 'string' || value.length > 65) invalid();
  return handle(value);
}
export function checkedRemoteSocialRequest(value: unknown, inspect = false): SocialRequest {
  const input = object(value);
  exact(input, ['kind','targetUrl'], ['text']);
  if (typeof input.kind !== 'string' || !(REMOTE_SOCIAL_KINDS as readonly string[]).includes(input.kind) || typeof input.targetUrl !== 'string') invalid();
  let target: URL;
  try { target = new URL(input.targetUrl); } catch { return invalid(); }
  if (target.protocol !== 'https:' || !['threads.com','www.threads.com','threads.net','www.threads.net'].includes(target.hostname) ||
      target.username || target.password || target.port || target.search || target.hash) invalid();
  target.hostname = 'www.threads.com'; target.pathname = target.pathname.replace(/\/$/, '') || '/';
  const path = target.pathname;
  if (input.kind === 'publish' ? path !== '/' : ['follow','unfollow'].includes(input.kind) ?
      !/^\/@[A-Za-z0-9_.]{1,64}$/.test(path) : !/^\/@[A-Za-z0-9_.]{1,64}\/post\/[A-Za-z0-9_-]{1,100}$/.test(path)) invalid();
  if (publication(input.kind)) {
    if (!(inspect && input.text === undefined) && (typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > 500)) invalid();
  } else if (Object.hasOwn(input, 'text')) invalid();
  return { kind: input.kind as SocialRequest['kind'], targetUrl: target.href, ...(input.text === undefined ? {} : { text: input.text as string }) };
}
export function checkedRemoteSocialArgs(value: unknown, inspect = false): { request: SocialRequest; expectedAccount: string } {
  const input = object(value);
  exact(input, ['kind','targetUrl','expectedAccount'], ['text']);
  const { expectedAccount, ...request } = input;
  return { request: checkedRemoteSocialRequest(request, inspect), expectedAccount: remoteAccount(expectedAccount) };
}
export function assertRemoteViewer(page: PageRead, expectedAccount: string): void {
  if (!page?.viewer?.username) throw new ThreadsError('UNKNOWN_ACCOUNT', 'A unique signed-in account is required.');
  if (remoteAccount(page.viewer.username) !== expectedAccount) throw new ThreadsError('ACCOUNT_MISMATCH', 'The selected browser account differs from expectedAccount.');
}
export function assertRemoteDraftSafe(page: PageRead): void {
  const state = page?.composerState;
  if (!state || state.present !== false || state.nonempty !== false || state.attachments !== false || state.ambiguous !== false)
    throw new ThreadsError('COMPOSER_BUSY', 'An absent, empty and unambiguous composer is required before remote navigation or preparation.');
}

/** Narrow internal capability: reads retain their existing gate; no raw UI/media/delete commands. */
export class RemoteSocialDriver implements BrowserDriver {
  private generation = 0;
  private expectedAccount?: string;
  private stages = new Map<string, { request: SocialRequest; account: string; committed: boolean }>();
  constructor(private readonly base: BrowserDriver, private readonly readDriver: BrowserDriver, private readonly assertAccess: () => void = () => {}) {}
  status() { return this.readDriver.status(); }
  refreshStatus() { return this.readDriver.refreshStatus?.() ?? Promise.resolve(this.readDriver.status()); }
  close() { this.invalidatePrepared(); return this.readDriver.close(); }
  invalidatePrepared(): void { this.generation++; this.stages.clear(); this.expectedAccount = undefined; }
  expectAccount(expectedAccount: string): void { this.expectedAccount = remoteAccount(expectedAccount); }
  private assertGeneration(generation: number): void {
    this.assertAccess();
    if (this.generation !== generation) throw new ThreadsError('ACTION_CANCELLED', 'Remote preparation was invalidated. Prepare again.');
  }
  async command<T>(command: Record<string, unknown>): Promise<T> {
    if (command.type !== 'social') return this.readDriver.command<T>(command);
    const generation = this.generation;
    const operation = command.operation;
    if (!['inspect','stage','commit'].includes(String(operation))) invalid();
    if (operation === 'commit') {
      exact(command, ['type','operation','token','expectedAccount']);
      const expected = remoteAccount(command.expectedAccount);
      if (typeof command.token !== 'string') invalid();
      const stage = this.stages.get(command.token);
      if (!stage || stage.committed) throw new ThreadsError('INVALID_ACTION', 'Remote preparation is absent or consumed.');
      // Consume before awaits: no error path can replay this token.
      stage.committed = true;
      if (stage.account !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Expected account differs from preparation.');
      const page = await this.base.command<PageRead>({ type: 'read' });
      this.assertGeneration(generation); assertRemoteViewer(page, expected);
      if (!sameThreadsRoute(page.url, stage.request.targetUrl)) throw new ThreadsError('TARGET_CHANGED_ROUTE', 'The selected tab left the prepared target.');
      this.assertGeneration(generation);
      return this.base.command<T>({ type: 'social', operation: 'commit', token: command.token, expectedAccount: expected });
    }
    exact(command, ['type','operation','request'], operation === 'inspect' ? ['token'] : []);
    const request = checkedRemoteSocialRequest(command.request, operation === 'inspect');
    let tokenStage: { request: SocialRequest; account: string; committed: boolean } | undefined;
    if (Object.hasOwn(command, 'token')) {
      if (typeof command.token !== 'string') invalid();
      tokenStage = this.stages.get(command.token);
      if (!tokenStage || JSON.stringify(tokenStage.request) !== JSON.stringify(request)) throw new ThreadsError('INVALID_ACTION', 'Inspection is not bound to this preparation.');
    }
    const page = await this.base.command<PageRead>({ type: 'read' });
    this.assertGeneration(generation);
    const ownPublishedRoute = tokenStage?.committed && publication(request.kind) &&
      new RegExp(`^https://www\\.threads\\.com/@${tokenStage.account.replace(/\./g, '\\.')}\/post\/[A-Za-z0-9_-]+\/?$`).test(page.url);
    if (!sameThreadsRoute(page.url, request.targetUrl) && !ownPublishedRoute) throw new ThreadsError('TARGET_CHANGED_ROUTE', 'Navigate to the exact social target before inspection or preparation.');
    const expected = tokenStage?.account ?? this.expectedAccount;
    if (!expected) throw new ThreadsError('UNKNOWN_ACCOUNT', 'An expected account binding is required.');
    assertRemoteViewer(page, expected);
    if (operation === 'stage') assertRemoteDraftSafe(page);
    this.assertGeneration(generation);
    const result = await this.base.command<T>({ type: 'social', operation, request, ...(command.token === undefined ? {} : { token: command.token }) });
    this.assertGeneration(generation);
    if (operation === 'stage') {
      const stage = result as SocialStage;
      if (!stage || typeof stage.token !== 'string' || !stage.token || stage.token.length > 200 ||
          JSON.stringify(checkedRemoteSocialRequest(stage.request)) !== JSON.stringify(request) || !sameThreadsRoute(stage.url, request.targetUrl))
        throw new ThreadsError('INVALID_ACTION', 'The browser returned an unbound social preparation.');
      const account = remoteAccount(stage.account);
      assertRemoteViewer(page, account);
      this.stages.clear(); this.stages.set(stage.token, { request, account, committed: false });
    }
    return result;
  }
}
