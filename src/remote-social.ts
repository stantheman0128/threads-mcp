import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import { SocialActions } from './social-actions.js';
import type { SocialConfirmationStage } from './social-runtime.js';
import { sameThreadsRoute, type ThreadsService } from './service.js';
import { ThreadsError } from './types.js';
import { RemoteSocialDriver, checkedRemoteSocialArgs, remoteAccount, assertRemoteDraftSafe, assertRemoteMediaDraftSafe, assertRemoteViewer, type RemoteMediaAuthorizer, type RemoteSocialOptions } from './remote-social-driver.js';
export { REMOTE_SOCIAL_KINDS } from './remote-social-driver.js';
export type { RemoteMediaAuthorizer, RemoteSocialOptions } from './remote-social-driver.js';
interface DeleteSource { sourceToken: string; account: string; targetUrl: string; expires: number; eligible: boolean; }
interface PreparedConfirmation { token: string; sourceId: string; account: string; targetUrl: string; expires: number; }

/** One instance per HTTP host lifetime, shared by every authenticated request. */
export class RemoteSocialController {
  private generation = 0;
  private readonly driver: RemoteSocialDriver;
  private readonly actions: SocialActions;
  private readonly deleteSources = new Map<string, DeleteSource>();
  private readonly confirmations = new Map<string, PreparedConfirmation>();
  constructor(private readonly service: ThreadsService, private readonly rawDriver: BrowserDriver, private readonly assertAccess: () => void = () => {},
    private readonly authorizeMedia?: RemoteMediaAuthorizer, private readonly options: RemoteSocialOptions = {}) {
    this.driver = new RemoteSocialDriver(rawDriver, service.driver, assertAccess, authorizeMedia, options);
    this.actions = new SocialActions(this.driver, { writesEnabled: service.config.writesEnabled,
      minActionIntervalMs: service.config.minActionIntervalMs, reserveWrite: () => service.reserveWrite(),
      audit: event => appendFileSync(join(service.config.dataDir, 'remote-actions.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }) });
  }
  invalidatePrepared(): void { this.generation++; this.actions.invalidatePrepared(); this.driver.invalidatePrepared(); this.deleteSources.clear(); this.confirmations.clear(); }
  private assertGeneration(generation: number): void {
    this.assertAccess();
    if (this.generation !== generation) throw new ThreadsError('ACTION_CANCELLED', 'Remote access changed during this operation. Prepare again.');
  }
  private async target(args: ReturnType<typeof checkedRemoteSocialArgs>, generation: number): Promise<void> {
    this.assertGeneration(generation);
    if (args.request.kind === 'delete' && new URL(args.request.targetUrl).pathname.split('/')[1]?.slice(1).toLowerCase() !== args.expectedAccount)
      throw new ThreadsError('ACCOUNT_MISMATCH', 'Remote delete is restricted to an exact own-post target.');
    this.driver.expectAccount(args.expectedAccount);
    let page = await this.rawDriver.command<PageRead>({ type: 'read' });
    this.assertGeneration(generation); assertRemoteViewer(page, args.expectedAccount);
    if (args.request.mediaToken) {
      if (!sameThreadsRoute(page.url, args.request.targetUrl)) throw new ThreadsError('TARGET_CHANGED_ROUTE', 'Authorized media must remain on its existing composer route; remote navigation is forbidden.');
      this.authorizeMedia!(args.request, args.expectedAccount);
      this.assertGeneration(generation); assertRemoteMediaDraftSafe(page);
      return;
    }
    assertRemoteDraftSafe(page);
    if (!sameThreadsRoute(page.url, args.request.targetUrl)) {
      await this.driver.command({ type: 'navigate', url: args.request.targetUrl });
      this.assertGeneration(generation);
      page = await this.rawDriver.command<PageRead>({ type: 'read' });
      this.assertGeneration(generation); assertRemoteViewer(page, args.expectedAccount); assertRemoteDraftSafe(page);
      if (!sameThreadsRoute(page.url, args.request.targetUrl)) throw new ThreadsError('TARGET_CHANGED_ROUTE', 'Navigation did not establish the exact requested target.');
    }
  }
  inspect(value: unknown) {
    const generation = this.generation;
    return this.service.serial(async () => {
      const args = checkedRemoteSocialArgs(value, true, !!this.authorizeMedia, !!this.options.allowDelete);
      await this.target(args, generation);
      const result = await this.actions.inspect(args.request);
      this.assertGeneration(generation);
      if (remoteAccount(result.account) !== args.expectedAccount) throw new ThreadsError('ACCOUNT_MISMATCH', 'Inspection observed a different account.');
      return result;
    });
  }
  prepare(value: unknown) {
    const generation = this.generation;
    return this.service.serial(async () => {
      const args = checkedRemoteSocialArgs(value, false, !!this.authorizeMedia, !!this.options.allowDelete);
      if (!this.service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Remote social preparation requires explicitly enabled writes.');
      await this.target(args, generation);
      try {
        this.deleteSources.clear(); this.confirmations.clear();
        const result = await this.actions.prepare(args.request);
        this.assertGeneration(generation);
        if (remoteAccount(result.account) !== args.expectedAccount) throw new ThreadsError('ACCOUNT_MISMATCH', 'Preparation observed a different account.');
        if (args.request.kind === 'delete') this.deleteSources.set(result.id, { sourceToken: this.driver.deleteSourceToken(args.request, args.expectedAccount),
          account: args.expectedAccount, targetUrl: args.request.targetUrl, expires: Date.parse(result.expiresAt), eligible: false });
        return result;
      } catch (error) { this.actions.invalidatePrepared(); this.driver.invalidatePrepared(); throw error; }
    });
  }
  execute(id: string, expectedAccount: string, dispatchGuard?:()=>void) {
    const generation = this.generation;
    return this.service.serial(async () => {
      this.assertGeneration(generation);
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ThreadsError('INVALID_ACTION', 'Use the id returned by remote social preparation.');
      const source = this.deleteSources.get(id);
      // A failed/uncertain first dispatch cannot become a confirmation source.
      if (source) this.deleteSources.delete(id);
      this.driver.setExecutionGuard(dispatchGuard);
      let result:Awaited<ReturnType<SocialActions['execute']>>;
      try{result = await this.actions.execute(id, remoteAccount(expectedAccount));}
      finally{this.driver.setExecutionGuard(undefined);}
      if (source) this.assertGeneration(generation);
      if (source && result.outcome === 'confirmation-required' && result.after && result.after.account === source.account &&
          sameThreadsRoute(result.after.targetUrl, source.targetUrl) && sameThreadsRoute(result.after.url, source.targetUrl))
        this.deleteSources.set(id, { ...source, eligible: true });
      return result;
    });
  }
  prepareConfirmation(sourceId: string, expectedAccount: string, purpose: string) {
    const generation = this.generation;
    return this.service.serial(async () => {
      this.assertGeneration(generation); this.requireDelete();
      if (typeof purpose !== 'string' || !purpose.trim() || Array.from(purpose).length > 500) throw new ThreadsError('INVALID_INPUT', 'An explicit final-delete purpose of 1–500 characters is required.');
      const source = this.deleteSources.get(sourceId);
      if (!source?.eligible) throw new ThreadsError('INVALID_ACTION', 'Execute an exact own-post delete and observe confirmation-required first.');
      this.deleteSources.delete(sourceId);
      if (Date.now() > source.expires) throw new ThreadsError('EXPIRED_ACTION', 'Prepare the delete action again.');
      const expected = remoteAccount(expectedAccount);
      if (expected !== source.account) throw new ThreadsError('ACCOUNT_MISMATCH', 'Expected account differs from the delete source.');
      const stage = await this.driver.command<SocialConfirmationStage>({ type: 'social', operation: 'prepare_confirmation', sourceToken: source.sourceToken, expectedAccount: expected });
      this.assertGeneration(generation);
      const id = randomUUID(); const expires = Math.min(Date.now() + 90_000, Date.parse(stage.expiresAt));
      this.confirmations.clear(); this.confirmations.set(id, { token: stage.token, sourceId, account: source.account, targetUrl: source.targetUrl, expires });
      return { id, sourceId, account: source.account, targetUrl: source.targetUrl, kind: 'delete' as const, purpose,
        expiresAt: new Date(expires).toISOString(), staged: true, dispatched: false,
        warning: 'This separate single-use preparation permits the final Delete confirmation. Absence of the post alone will not prove deletion.' };
    });
  }
  executeConfirmation(id: string, expectedAccount: string) {
    const generation = this.generation;
    return this.service.serial(async () => {
      this.assertGeneration(generation); this.requireDelete();
      const pending = this.confirmations.get(id);
      if (!pending) throw new ThreadsError('INVALID_ACTION', 'Final confirmation is absent or consumed.');
      this.confirmations.delete(id);
      if (Date.now() > pending.expires) throw new ThreadsError('EXPIRED_ACTION', 'Prepare the delete action again.');
      const expected = remoteAccount(expectedAccount);
      if (expected !== pending.account) throw new ThreadsError('ACCOUNT_MISMATCH', 'Expected account differs from final confirmation.');
      this.service.reserveWrite();
      const audit = (outcome: string) => appendFileSync(join(this.service.config.dataDir, 'remote-actions.jsonl'),
        JSON.stringify({ id, kind: 'delete-confirmation', targetUrl: pending.targetUrl, outcome }) + '\n', { mode: 0o600 });
      audit('commit-started');
      try {
        const dispatch = await this.driver.command<{ dispatched: boolean; noop: boolean }>({ type: 'social', operation: 'commit_confirmation', token: pending.token, expectedAccount: expected });
        audit('outcome-uncertain');
        return { id, sourceId: pending.sourceId, outcome: 'outcome-uncertain', verified: false, dispatch: { dispatched: dispatch.dispatched === true, noop: false },
          message: 'The final confirmation was dispatched once. Deletion is not proven by absence alone; do not replay this action.' };
      } catch (error) {
        audit('outcome-uncertain');
        return { id, sourceId: pending.sourceId, outcome: 'outcome-uncertain', verified: false, error: error instanceof ThreadsError ? error.code : 'SOCIAL_COMMAND_FAILED',
          message: 'Final confirmation failed or its outcome is uncertain. The preparation remains consumed; do not replay it.' };
      }
    });
  }
  private requireDelete(): void {
    if (!this.options.allowDelete) throw new ThreadsError('DELETE_DISABLED', 'Explicit remote delete permission is required.');
    if (!this.service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Explicit writes permission is required.');
  }
}
