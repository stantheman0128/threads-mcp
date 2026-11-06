import { randomUUID } from 'node:crypto';
import { ThreadsError } from './types.js';
import { handle } from './urls.js';
import type { SocialRequest, SocialObservation, SocialStage } from './social-runtime.js';

export type { SocialRequest, SocialObservation, SocialStage } from './social-runtime.js';
export interface SocialDriver { command<T>(command: Record<string, unknown>): Promise<T>; }
export interface SocialOptions {
  writesEnabled: boolean;
  minActionIntervalMs: number;
  verificationAttempts?: number;
  verificationDelayMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  reserveWrite?: () => void;
  audit?: (event: { id: string; kind: string; targetUrl: string; outcome: string }) => void;
}
interface Prepared { id: string; stage: SocialStage; expires: number; }

/** The caller must share its browser-operation mutex with this controller. */
export class SocialActions {
  private prepared = new Map<string, Prepared>();
  private lastWrite = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private driver: SocialDriver, private options: SocialOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private serial<T>(fn: () => Promise<T>) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private enabled() { if (!this.options.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Enable THREADS_ALLOW_WRITES before staging or executing social actions.'); }
  inspect(request: SocialRequest) { return this.serial(() => this.driver.command<SocialObservation>({ type: 'social', operation: 'inspect', request })); }
  prepare(request: SocialRequest) { return this.serial(async () => {
    this.enabled();
    // Preparing may open a menu or fill a local draft; it never clicks submit.
    const stage = await this.driver.command<SocialStage>({ type: 'social', operation: 'stage', request });
    if (!stage.account) throw new ThreadsError('UNKNOWN_ACCOUNT', 'The browser did not establish the signed-in account.');
    const action: Prepared = { id: randomUUID(), stage, expires: this.now() + 90_000 };
    this.prepared.clear(); this.prepared.set(action.id, action);
    return { id: action.id, account: stage.account, request: stage.request, before: stage.before, noop: stage.noop,
      expiresAt: new Date(action.expires).toISOString(), staged: true, published: false,
      warning: 'Review the exact account, target and content. Execution consumes this preparation once, including uncertain outcomes.' };
  }); }
  execute(id: string, expectedAccount: string) { return this.serial(async () => {
    this.enabled();
    const action = this.prepared.get(id);
    if (!action) throw new ThreadsError('INVALID_ACTION', 'The social action is absent or already consumed.');
    this.prepared.delete(id);
    if (this.now() > action.expires) throw new ThreadsError('EXPIRED_ACTION', 'Prepare the social action again.');
    if (handle(expectedAccount) !== handle(action.stage.account)) throw new ThreadsError('ACCOUNT_MISMATCH', 'Expected account differs from the staged account.');
    if (!action.stage.noop && !this.options.reserveWrite && this.now() - this.lastWrite < this.options.minActionIntervalMs)
      throw new ThreadsError('ACTION_COOLDOWN', 'Wait for the action cooldown, then prepare again.');
    const audit = (outcome: string) => this.options.audit?.({ id, kind: action.stage.request.kind, targetUrl: action.stage.request.targetUrl, outcome });
    if (!action.stage.noop) {
      if (this.options.reserveWrite) this.options.reserveWrite();
      else this.lastWrite = this.now();
    }
    audit('commit-started');
    try {
      const dispatch = await this.driver.command<{ dispatched: boolean; noop: boolean }>({ type: 'social', operation: 'commit', token: action.stage.token, expectedAccount });
      let after: SocialObservation | undefined;
      let verificationError: string | undefined;
      for (let i = 0; i < Math.max(1, Math.min(12, this.options.verificationAttempts ?? 8)); i++) {
        if (i) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(this.options.verificationDelayMs ?? 500);
        try {
          after = await this.driver.command<SocialObservation>({ type: 'social', operation: 'inspect', request: action.stage.request, token: action.stage.token });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== 'UI_NOT_READY' && !/^AMBIGUOUS_UI(?:_(?:POST_SCOPE|PROFILE_SCOPE|MENU_TRIGGER|MENU_CONTENT|ACTION_STATE|ACTION_CONTROL))?$/.test(code ?? '')) throw error;
          verificationError = code; continue; // Readiness retries never repeat the commit.
        }
        const publishedRoute = ['publish','reply','quote'].includes(action.stage.request.kind) && after.postUrl === after.url &&
          after.url.startsWith(`https://www.threads.com/@${action.stage.account}/post/`) && after.targetUrl === action.stage.request.targetUrl;
        if (after.account !== action.stage.account || (after.url !== action.stage.url && !publishedRoute)) break;
        if (after.state === 'confirmation-required') {
          audit('confirmation-required');
          return { id, outcome: 'confirmation-required', verified: false, dispatch, before: action.stage.before, after,
            message: 'A confirmation is visible. No confirmation was clicked; inspect its exact target before preparing the next interaction.' };
        }
        if (after.verified) {
          audit(dispatch.noop ? 'already-satisfied' : 'verified');
          return { id, outcome: dispatch.noop ? 'already-satisfied' : 'verified', verified: true, dispatch, before: action.stage.before, after };
        }
      }
      audit('outcome-uncertain');
      return { id, outcome: 'outcome-uncertain', verified: false, dispatch, before: action.stage.before, after, ...(verificationError ? { verificationError } : {}),
        message: 'The intended application result was not established. Inspect the account and target before any new action; do not replay the commit.' };
    } catch (error) {
      audit('outcome-uncertain');
      return { id, outcome: 'outcome-uncertain', verified: false,
        error: error instanceof ThreadsError ? error.code : 'SOCIAL_COMMAND_FAILED',
        message: 'Commit or verification failed; the action remains consumed. Inspect the current account and target before preparing another action.' };
    }
  }); }
}
