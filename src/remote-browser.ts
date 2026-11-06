import { randomUUID } from 'node:crypto';
import type { BrowserDriver } from './driver.js';
import type { ThreadsService } from './service.js';
import { ThreadsError } from './types.js';
import { checkedRemoteBrowserUrl, remoteBrowserRouteName, type RemoteBrowserSnapshot } from './remote-browser-runtime.js';

function fail(code = 'INVALID_INPUT'): never { throw new ThreadsError(code, 'Remote browser fallback request was denied or changed.'); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const input = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...required, ...optional].includes(key))) fail();
  return input;
}
function account(value: unknown): string {
  if (typeof value !== 'string' || !/^@?[A-Za-z0-9_.]{1,64}$/.test(value)) fail();
  return value.replace(/^@/, '').toLowerCase();
}
interface Prepared { token: string; account: string; destination: string; sourceUrl: string; expires: number; generation: number; }

/** Narrow semantic read navigation, intentionally not parity with unrestricted local browser tools. */
export class RemoteBrowserController {
  private generation = 0;
  private prepared = new Map<string, Prepared>();
  private currentSnapshot?: { id: string; account: string; expires: number };
  constructor(private readonly service: ThreadsService, private readonly rawDriver: BrowserDriver, private readonly assertAccess: () => void) {}
  invalidate(): void { this.generation++; this.prepared.clear(); this.currentSnapshot = undefined; }
  private check(generation: number): void {
    this.assertAccess();
    if (!this.service.config.writesEnabled) fail('WRITES_DISABLED');
    if (generation !== this.generation) fail('ACCESS_CHANGED');
  }
  private async command<T>(command: Record<string, unknown>, generation: number): Promise<T> {
    this.check(generation);
    const result = await this.rawDriver.command<T>({ type: 'remote_browser', ...command });
    this.check(generation); return result;
  }
  private cleanSnapshot(value: unknown, expected: string): RemoteBrowserSnapshot {
    const result = object(value, ['snapshotId', 'account', 'url', 'observedAt', 'expiresAt', 'elements', 'scope', 'warnings']);
    if (account(result.account) !== expected || typeof result.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/i.test(result.snapshotId) ||
        typeof result.observedAt !== 'string' || !Number.isFinite(Date.parse(result.observedAt)) || typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) ||
        result.scope !== 'public-read-navigation' || !Array.isArray(result.elements) || result.elements.length > 80) fail('REMOTE_BROWSER_INVALID_RESULT');
    const elements = result.elements.map(raw => {
      const ref = object(raw, ['ref', 'kind', 'name', 'verb'], ['url']);
      if (typeof ref.ref !== 'string' || !/^r\d{1,2}$/.test(ref.ref)) fail('REMOTE_BROWSER_INVALID_RESULT');
      if (ref.kind === 'navigation' && ref.verb === 'click') { const url = checkedRemoteBrowserUrl(ref.url); return { ref: ref.ref, kind: 'navigation' as const, name: remoteBrowserRouteName(url), verb: 'click' as const, url }; }
      if (ref.kind === 'search' && ref.verb === 'fill' && ref.url === undefined) return { ref: ref.ref, kind: 'search' as const, name: 'Public search query', verb: 'fill' as const };
      return fail('REMOTE_BROWSER_INVALID_RESULT');
    });
    this.currentSnapshot = { id: result.snapshotId, account: expected, expires: Date.parse(result.expiresAt) };
    return { snapshotId: result.snapshotId, account: expected, url: checkedRemoteBrowserUrl(result.url), observedAt: result.observedAt, expiresAt: result.expiresAt,
      elements, scope: 'public-read-navigation', warnings: ['Only vetted read-navigation links and public search are available. Generic UI controls and private page text are excluded.'] };
  }
  snapshot(value: unknown): Promise<RemoteBrowserSnapshot> {
    const generation = this.generation;
    return this.service.serial(async () => {
      const input = object(value, ['expectedAccount']), expected = account(input.expectedAccount);
      this.prepared.clear();
      return this.cleanSnapshot(await this.command({ operation: 'snapshot', expectedAccount: expected }, generation), expected);
    });
  }
  scroll(value: unknown): Promise<RemoteBrowserSnapshot> {
    const generation = this.generation;
    return this.service.serial(async () => {
      const input = object(value, ['expectedAccount', 'pixels']), expected = account(input.expectedAccount);
      if (!Number.isInteger(input.pixels) || Number(input.pixels) === 0 || Math.abs(Number(input.pixels)) > 2000) fail();
      this.prepared.clear();
      return this.cleanSnapshot(await this.command({ operation: 'scroll', expectedAccount: expected, pixels: input.pixels }, generation), expected);
    });
  }
  prepare(value: unknown) {
    const generation = this.generation;
    return this.service.serial(async () => {
      const input = object(value, ['snapshotId', 'ref', 'verb', 'expectedAccount', 'purpose'], ['value']), expected = account(input.expectedAccount);
      if (typeof input.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.snapshotId) || typeof input.ref !== 'string' || !/^r\d{1,2}$/.test(input.ref) ||
          !['click', 'fill'].includes(String(input.verb)) || typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 300 || /[\x00-\x1f\x7f]/.test(input.purpose)) fail();
      if (input.verb === 'click' ? input.value !== undefined : typeof input.value !== 'string' || !input.value.trim() || [...input.value].length > 200 || /[\x00-\x1f\x7f]/.test(input.value)) fail();
      if (!this.currentSnapshot || this.currentSnapshot.id !== input.snapshotId || this.currentSnapshot.account !== expected || this.currentSnapshot.expires <= Date.now()) fail('REMOTE_BROWSER_STALE');
      this.prepared.clear();
      const result = await this.command<Record<string, unknown>>({ ...input, operation: 'prepare', expectedAccount: expected }, generation);
      if (account(result.account) !== expected || typeof result.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(result.token) || typeof result.expiresAt !== 'string') fail('REMOTE_BROWSER_INVALID_RESULT');
      const expires = Date.parse(result.expiresAt);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 61_000) fail('REMOTE_BROWSER_INVALID_RESULT');
      const destination = checkedRemoteBrowserUrl(result.destination), sourceUrl = checkedRemoteBrowserUrl(result.sourceUrl), id = randomUUID();
      this.prepared.set(id, { token: result.token, account: expected, sourceUrl, destination, expires, generation });
      return { id, expectedAccount: expected, sourceUrl, destination, action: 'navigate', purpose: input.purpose, expiresAt: new Date(expires).toISOString(), dispatched: false };
    });
  }
  execute(value: unknown) {
    const generation = this.generation;
    return this.service.serial(async () => {
      const input = object(value, ['id', 'expectedAccount']), expected = account(input.expectedAccount);
      if (typeof input.id !== 'string') fail();
      const current = this.prepared.get(input.id); this.prepared.delete(input.id);
      this.currentSnapshot = undefined;
      this.check(generation);
      if (!current || current.generation !== generation || current.account !== expected || Date.now() >= current.expires) fail('INVALID_ACTION');
      const result = await this.command<Record<string, unknown>>({ operation: 'consume', token: current.token, expectedAccount: expected }, generation);
      if (account(result.account) !== expected || checkedRemoteBrowserUrl(result.destination) !== current.destination || checkedRemoteBrowserUrl(result.sourceUrl) !== current.sourceUrl ||
          result.dispatched !== true || result.verified !== false) fail('REMOTE_BROWSER_INVALID_RESULT');
      // The runtime dispatched its bound URL atomically. Do not navigate again,
      // retry an uncertain transport, or read a new page as part of execution.
      return { status: 'navigation-unverified', dispatched: true, verified: false, destination: current.destination };
    });
  }
}
