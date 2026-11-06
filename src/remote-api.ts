import { randomUUID } from 'node:crypto';
import { OfficialThreadsApi, OfficialApiError, officialApiOptionsFromEnv, officialActionSchema,
  type OfficialApiOptions, type OfficialAction, type OfficialReadInput, type OfficialReadOperation,
  type OfficialPreparedAction } from './official-api.js';
import type { ThreadsService } from './service.js';
import { ThreadsError } from './types.js';

interface Prepared {
  apiId: string; account: string; purpose: string; action: OfficialAction; expires: number;
}
const numericId = /^\d{1,40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Construct only for the explicit remote official-API opt-in. Credentials are host-owned. */
export class RemoteOfficialApiController {
  private generation = 0;
  private api: OfficialThreadsApi;
  #options: OfficialApiOptions;
  private readonly transport: typeof fetch;
  private readonly prepared = new Map<string, Prepared>();

  constructor(private readonly service: ThreadsService, private readonly assertAccess: () => void,
    private readonly gates: { allowDelete: boolean }) {
    this.#options = { ...officialApiOptionsFromEnv(), writesEnabled: service.config.writesEnabled };
    this.transport = globalThis.fetch;
    this.api = this.newApi();
  }

  private check(generation = this.generation): void {
    this.assertAccess();
    if (generation !== this.generation) throw new ThreadsError('API_PREPARATION_REVOKED', 'Remote API access changed; the old preparation is invalid.');
  }

  private newApi(): OfficialThreadsApi {
    const generation = this.generation;
    return new OfficialThreadsApi({ ...this.#options, fetch: async (url, init) => {
      // Every identity/status read and mutation goes through this synchronous dispatch gate.
      // The captured generation also stops an old instance after invalidate/replacement.
      try { this.check(generation); }
      catch { throw new OfficialApiError('API_ACCESS_CHANGED', 'Remote API access changed before dispatch; no request was sent.', 'not_sent'); }
      if (init?.method !== 'GET' && !this.service.config.writesEnabled)
        throw new OfficialApiError('WRITES_DISABLED', 'Remote API writes are disabled; no request was sent.', 'not_sent');
      if (init?.method === 'DELETE' && !this.gates.allowDelete)
        throw new OfficialApiError('REMOTE_DELETE_DISABLED', 'Remote API deletion is disabled; no request was sent.', 'not_sent');
      return this.transport(url, init);
    } });
  }

  status() {
    this.check();
    return { ...this.api.status(), remoteOfficialApiEnabled: true,
      writesEnabled: this.service.config.writesEnabled, deleteEnabled: this.service.config.writesEnabled && this.gates.allowDelete,
      preparationScope: 'host-lifetime', credentialSource: 'host-environment' };
  }

  async read(operation: OfficialReadOperation, input: OfficialReadInput = {}) {
    const generation = this.generation; this.check(generation);
    const result = await this.api.read(operation, input);
    this.check(generation);
    return result;
  }

  private account(value: unknown): string {
    if (typeof value !== 'string' || !numericId.test(value))
      throw new ThreadsError('INVALID_INPUT', 'expectedAccount must be the exact numeric official API account ID.');
    const configured = this.api.status().userId;
    if (configured === 'me') throw new ThreadsError('API_IDENTITY_REQUIRED', 'Configure the exact host API user ID before preparing writes.');
    if (value !== configured) throw new ThreadsError('API_IDENTITY_MISMATCH', 'Expected account differs from the configured official API identity.');
    return value;
  }

  private writeGuard(action: OfficialAction): void {
    if (!this.service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Remote official API writes require the explicit write setting.');
    if (action.kind === 'delete_post' && !this.gates.allowDelete)
      throw new ThreadsError('REMOTE_DELETE_DISABLED', 'Remote official API deletion requires the separate delete setting.');
  }

  async prepare(action: OfficialAction, expectedAccount: string, purpose: string) {
    const generation = this.generation; this.check(generation);
    const parsed = officialActionSchema.safeParse(action);
    if (!parsed.success) throw new ThreadsError('INVALID_INPUT', 'Use a supported official API action with its exact fields.');
    const fixed = parsed.data;
    this.writeGuard(fixed);
    const account = this.account(expectedAccount);
    if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500 || /[\x00-\x1f\x7f]/.test(purpose) ||
      (this.#options.accessToken?.trim() && [this.#options.accessToken.trim(), encodeURIComponent(this.#options.accessToken.trim())].some(token => purpose.includes(token))))
      throw new ThreadsError('INVALID_INPUT', 'Provide an explicit nonempty purpose of at most 500 characters without credentials.');
    const now = Date.now();
    for (const [key, item] of this.prepared) if (item.expires <= now) this.prepared.delete(key);
    if (this.prepared.size >= 100) throw new ThreadsError('API_PREPARED_LIMIT', 'Too many pending remote API preparations.');
    const result: OfficialPreparedAction = await this.api.prepare(fixed);
    this.check(generation); this.writeGuard(fixed);
    if (result.account.id !== account) throw new ThreadsError('API_IDENTITY_MISMATCH', 'Authenticated API identity differs from the expected account.');
    const id = randomUUID();
    this.prepared.set(id, { apiId: result.preparedId, account, purpose, action: structuredClone(result.action), expires: Date.parse(result.expiresAt) });
    return { id, account: result.account, action: result.action, purpose, expiresAt: result.expiresAt, prepared: true, executed: false };
  }

  async execute(id: string, expectedAccount: string) {
    const generation = this.generation; this.check(generation);
    if (typeof id !== 'string' || !uuid.test(id)) throw new ThreadsError('INVALID_INPUT', 'Use the remote preparation ID returned by prepare.');
    const entry = this.prepared.get(id);
    if (!entry) throw new ThreadsError('API_PREPARED_NOT_FOUND', 'Remote preparation is absent or consumed; never replay uncertain execution.');
    this.prepared.delete(id); // Consume before account validation, identity reads or any mutation.
    this.writeGuard(entry.action);
    const account = this.account(expectedAccount);
    if (account !== entry.account) throw new ThreadsError('API_IDENTITY_MISMATCH', 'Expected account differs from the prepared API identity.');
    if (entry.expires <= Date.now()) throw new ThreadsError('API_PREPARED_EXPIRED', 'Remote API preparation expired.');
    const result = await this.api.execute(entry.apiId);
    // A confirmed remote result after revocation must not escape as a fresh authorization.
    // The preparation is already consumed and cannot be replayed on this error path.
    try { this.check(generation); }
    catch { throw new OfficialApiError('API_ACCESS_CHANGED', 'Remote API access changed during execution; inspect account state and never replay.', 'unknown'); }
    return { ...result, preparedId: id, purpose: entry.purpose };
  }

  invalidate(): void {
    this.generation++;
    this.prepared.clear();
    this.api = this.newApi();
  }
}
