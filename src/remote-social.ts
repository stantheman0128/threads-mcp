import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import { SocialActions } from './social-actions.js';
import { sameThreadsRoute, type ThreadsService } from './service.js';
import { ThreadsError } from './types.js';
import { RemoteSocialDriver, checkedRemoteSocialArgs, remoteAccount, assertRemoteDraftSafe, assertRemoteViewer } from './remote-social-driver.js';
export { REMOTE_SOCIAL_KINDS } from './remote-social-driver.js';

/** One instance per HTTP host lifetime, shared by every authenticated request. */
export class RemoteSocialController {
  private generation = 0;
  private readonly driver: RemoteSocialDriver;
  private readonly actions: SocialActions;
  constructor(private readonly service: ThreadsService, private readonly rawDriver: BrowserDriver, private readonly assertAccess: () => void = () => {}) {
    this.driver = new RemoteSocialDriver(rawDriver, service.driver, assertAccess);
    this.actions = new SocialActions(this.driver, { writesEnabled: service.config.writesEnabled,
      minActionIntervalMs: service.config.minActionIntervalMs, reserveWrite: () => service.reserveWrite(),
      audit: event => appendFileSync(join(service.config.dataDir, 'remote-actions.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }) });
  }
  invalidatePrepared(): void { this.generation++; this.actions.invalidatePrepared(); this.driver.invalidatePrepared(); }
  private assertGeneration(generation: number): void {
    this.assertAccess();
    if (this.generation !== generation) throw new ThreadsError('ACTION_CANCELLED', 'Remote access changed during this operation. Prepare again.');
  }
  private async target(args: ReturnType<typeof checkedRemoteSocialArgs>, generation: number): Promise<void> {
    this.assertGeneration(generation);
    this.driver.expectAccount(args.expectedAccount);
    let page = await this.rawDriver.command<PageRead>({ type: 'read' });
    this.assertGeneration(generation); assertRemoteViewer(page, args.expectedAccount); assertRemoteDraftSafe(page);
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
      const args = checkedRemoteSocialArgs(value, true);
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
      const args = checkedRemoteSocialArgs(value);
      if (!this.service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Remote social preparation requires explicitly enabled writes.');
      await this.target(args, generation);
      try {
        const result = await this.actions.prepare(args.request);
        this.assertGeneration(generation);
        if (remoteAccount(result.account) !== args.expectedAccount) throw new ThreadsError('ACCOUNT_MISMATCH', 'Preparation observed a different account.');
        return result;
      } catch (error) { this.actions.invalidatePrepared(); this.driver.invalidatePrepared(); throw error; }
    });
  }
  execute(id: string, expectedAccount: string) {
    const generation = this.generation;
    return this.service.serial(async () => {
      this.assertGeneration(generation);
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ThreadsError('INVALID_ACTION', 'Use the id returned by remote social preparation.');
      return this.actions.execute(id, remoteAccount(expectedAccount));
    });
  }
}
