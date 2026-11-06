import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import type { SocialRequest, SocialStage } from './social-actions.js';
import type { SocialConfirmationStage } from './social-runtime.js';
import { sameThreadsRoute } from './service.js';
import { handle } from './urls.js';
import { ThreadsError } from './types.js';

export const REMOTE_SOCIAL_KINDS = ['like','unlike','save','unsave','repost','unrepost','follow','unfollow','publish','reply','quote'] as const;
export type RemoteMediaAuthorizer = (request: SocialRequest, expectedAccount: string) => void;
export interface RemoteSocialOptions { allowDelete?: boolean; }
interface BoundStage { request: SocialRequest; account: string; committed: boolean; confirmationRequired?: boolean; confirmationPrepared?: boolean; }
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
export function checkedRemoteSocialRequest(value: unknown, inspect = false, allowMedia = false, allowDelete = false): SocialRequest {
  const input = object(value);
  exact(input, ['kind','targetUrl'], allowMedia ? ['text','mediaToken'] : ['text']);
  if (typeof input.kind !== 'string' || (!(REMOTE_SOCIAL_KINDS as readonly string[]).includes(input.kind) && !(allowDelete && input.kind === 'delete')) || typeof input.targetUrl !== 'string') invalid();
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
  } else if (Object.hasOwn(input, 'text') || Object.hasOwn(input, 'mediaToken')) invalid();
  if (Object.hasOwn(input, 'mediaToken') && (typeof input.mediaToken !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.mediaToken))) invalid();
  return { kind: input.kind as SocialRequest['kind'], targetUrl: target.href, ...(input.text === undefined ? {} : { text: input.text as string }),
    ...(input.mediaToken === undefined ? {} : { mediaToken: input.mediaToken as string }) };
}
export function checkedRemoteSocialArgs(value: unknown, inspect = false, allowMedia = false, allowDelete = false): { request: SocialRequest; expectedAccount: string } {
  const input = object(value);
  exact(input, ['kind','targetUrl','expectedAccount'], allowMedia ? ['text','mediaToken'] : ['text']);
  const { expectedAccount, ...request } = input;
  return { request: checkedRemoteSocialRequest(request, inspect, allowMedia, allowDelete), expectedAccount: remoteAccount(expectedAccount) };
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
export function assertRemoteMediaDraftSafe(page: PageRead): void {
  const state = page?.composerState;
  if (!state || state.present !== true || state.attachments !== true || state.nonempty !== false || state.ambiguous !== false)
    throw new ThreadsError('COMPOSER_BUSY', 'Authorized media requires one attachment composer with no existing text draft.');
}

/** Narrow internal capability: reads retain their existing gate; no raw UI/media/delete commands. */
export class RemoteSocialDriver implements BrowserDriver {
  private executionGuard?:()=>void;
  setExecutionGuard(guard?:()=>void):void{this.executionGuard=guard;}
  private generation = 0;
  private expectedAccount?: string;
  private stages = new Map<string, BoundStage>();
  private confirmations = new Map<string, { source: BoundStage; consumed: boolean }>();
  constructor(private readonly base: BrowserDriver, private readonly readDriver: BrowserDriver, private readonly assertAccess: () => void = () => {},
    private readonly authorizeMedia?: RemoteMediaAuthorizer, private readonly options: RemoteSocialOptions = {}) {}
  status() { return this.readDriver.status(); }
  refreshStatus() { return this.readDriver.refreshStatus?.() ?? Promise.resolve(this.readDriver.status()); }
  close() { this.invalidatePrepared(); return this.readDriver.close(); }
  invalidatePrepared(): void { this.generation++; this.stages.clear(); this.confirmations.clear(); this.expectedAccount = undefined; }
  deleteSourceToken(request: SocialRequest, account: string): string {
    const match = [...this.stages.entries()].filter(([, stage]) => stage.request.kind === 'delete' && !stage.committed &&
      stage.account === account && stage.request.targetUrl === request.targetUrl);
    if (!this.options.allowDelete || match.length !== 1) throw new ThreadsError('INVALID_ACTION', 'No unique prepared delete source exists.');
    return match[0]![0];
  }
  expectAccount(expectedAccount: string): void { this.expectedAccount = remoteAccount(expectedAccount); }
  private assertGeneration(generation: number): void {
    this.assertAccess();
    if (this.generation !== generation) throw new ThreadsError('ACTION_CANCELLED', 'Remote preparation was invalidated. Prepare again.');
  }
  async command<T>(command: Record<string, unknown>): Promise<T> {
    if (command.type !== 'social') return this.readDriver.command<T>(command);
    const generation = this.generation;
    const operation = command.operation;
    if (operation === 'prepare_confirmation' || operation === 'commit_confirmation') {
      if (!this.options.allowDelete) throw new ThreadsError('DELETE_DISABLED', 'Explicit remote delete permission is required.');
      const preparing = operation === 'prepare_confirmation';
      exact(command, ['type','operation', preparing ? 'sourceToken' : 'token', 'expectedAccount']);
      const token = preparing ? command.sourceToken : command.token;
      if (typeof token !== 'string') invalid();
      const expected = remoteAccount(command.expectedAccount);
      const pending = preparing ? undefined : this.confirmations.get(token);
      const source = preparing ? this.stages.get(token) : pending?.source;
      if (!source || source.request.kind !== 'delete' || !source.committed || !source.confirmationRequired ||
          (preparing ? source.confirmationPrepared : !pending || pending.consumed)) throw new ThreadsError('INVALID_ACTION', 'A matching consumed delete confirmation source is required.');
      if (preparing) source.confirmationPrepared = true; else pending!.consumed = true;
      if (source.account !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Expected account differs from the delete source.');
      const page = await this.base.command<PageRead>({ type: 'read' });
      this.assertGeneration(generation); assertRemoteViewer(page, expected);
      if (!sameThreadsRoute(page.url, source.request.targetUrl)) throw new ThreadsError('TARGET_CHANGED_ROUTE', 'The delete source route changed.');
      this.assertGeneration(generation);
      const result = await this.base.command<T>({ type: 'social', operation, ...(preparing ? { sourceToken: token } : { token }), expectedAccount: expected });
      this.assertGeneration(generation);
      if (preparing) {
        const stage = result as SocialConfirmationStage;
        if (!stage || typeof stage.token !== 'string' || !stage.token || stage.token.length > 200 || stage.sourceToken !== token || stage.kind !== 'delete' ||
            stage.account !== expected || !sameThreadsRoute(stage.targetUrl, source.request.targetUrl) || !sameThreadsRoute(stage.url, source.request.targetUrl) ||
            !Number.isFinite(Date.parse(stage.expiresAt)) || Date.parse(stage.expiresAt) <= Date.now() || Date.parse(stage.expiresAt) > Date.now() + 91_000)
          throw new ThreadsError('INVALID_ACTION', 'The final confirmation is not bound to its delete source.');
        this.confirmations.clear(); this.confirmations.set(stage.token, { source, consumed: false });
      }
      return result;
    }
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
      if (stage.request.mediaToken) this.authorizeMedia!(stage.request, expected);
      this.assertGeneration(generation);
      const executionGuard=this.executionGuard;
      return this.base.command<T>({ type: 'social', operation: 'commit', token: command.token, expectedAccount: expected },()=>{
        this.assertGeneration(generation);executionGuard?.();
        if(stage.request.mediaToken)this.authorizeMedia!(stage.request,expected);
      });
    }
    exact(command, ['type','operation','request'], operation === 'inspect' ? ['token'] : []);
    const request = checkedRemoteSocialRequest(command.request, operation === 'inspect', !!this.authorizeMedia, !!this.options.allowDelete);
    let tokenStage: BoundStage | undefined;
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
    if (operation === 'stage') {
      if (request.mediaToken) assertRemoteMediaDraftSafe(page); else assertRemoteDraftSafe(page);
    }
    this.assertGeneration(generation);
    if (request.mediaToken && (operation === 'stage' || !tokenStage)) this.authorizeMedia!(request, expected);
    this.assertGeneration(generation);
    const result = await this.base.command<T>({ type: 'social', operation, request, ...(command.token === undefined ? {} : { token: command.token }) });
    this.assertGeneration(generation);
    if (operation === 'inspect' && tokenStage?.committed && request.kind === 'delete') {
      const observation = result as { state?: string; account?: string; targetUrl?: string; url?: string };
      tokenStage.confirmationRequired = observation.state === 'confirmation-required' && observation.account === tokenStage.account &&
        typeof observation.targetUrl === 'string' && sameThreadsRoute(observation.targetUrl, request.targetUrl) &&
        typeof observation.url === 'string' && sameThreadsRoute(observation.url, request.targetUrl);
    }
    if (operation === 'stage') {
      if (request.mediaToken) this.authorizeMedia!(request, expected);
      this.assertGeneration(generation);
      const stage = result as SocialStage;
      if (!stage || typeof stage.token !== 'string' || !stage.token || stage.token.length > 200 ||
          JSON.stringify(checkedRemoteSocialRequest(stage.request, false, !!this.authorizeMedia, !!this.options.allowDelete)) !== JSON.stringify(request) || !sameThreadsRoute(stage.url, request.targetUrl))
        throw new ThreadsError('INVALID_ACTION', 'The browser returned an unbound social preparation.');
      const account = remoteAccount(stage.account);
      assertRemoteViewer(page, account);
      this.stages.clear(); this.confirmations.clear(); this.stages.set(stage.token, { request, account, committed: false });
    }
    return result;
  }
}
