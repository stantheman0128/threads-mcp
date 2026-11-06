import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserDriver } from './driver.js';
import { ThreadsError } from './types.js';

interface RemoteOptions { dataDir: string; port?: number; requestTimeoutMs?: number }
interface RemoteStatus {
  connected: boolean; running: boolean; port: number; pairingUrl: string;
  tab: { id: number; url: string; title?: string } | null;
}

export class RemoteExtensionDriver implements BrowserDriver {
  private token?: string;
  private port?: number;
  private closed = false;
  private hostStatus: RemoteStatus | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly options: RemoteOptions) {}

  /** Attach to the existing host. Only missing pairing and ECONNREFUSED imply no host. */
  async connect(): Promise<void> {
    if (this.closed) throw new ThreadsError('DRIVER_CLOSED', 'The remote driver is closed.');
    let contents: string;
    try { contents = await readFile(join(this.options.dataDir, 'bridge-pairing.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ThreadsError('BRIDGE_PAIRING_MISSING', 'No local bridge pairing file exists.');
      throw new ThreadsError('BRIDGE_PAIRING_UNREADABLE', 'Cannot read the local bridge pairing file.');
    }
    let pairing: { port?: unknown; token?: unknown };
    try { pairing = JSON.parse(contents); } catch { throw new ThreadsError('BRIDGE_PAIRING_INVALID', 'Local bridge pairing information is invalid.'); }
    if (!pairing || !Number.isInteger(pairing.port) || Number(pairing.port) < 1 || Number(pairing.port) > 65535 ||
      typeof pairing.token !== 'string' || !/^[a-f0-9]{64}$/.test(pairing.token) ||
      (this.options.port !== undefined && this.options.port !== pairing.port)) {
      throw new ThreadsError('BRIDGE_PAIRING_INVALID', 'Local bridge pairing port or token is invalid.');
    }
    // Ignore any URL from the file. All RPC requests always use numeric IPv4 loopback.
    this.port = Number(pairing.port);
    this.token = pairing.token;
    await this.request('/status', 'GET');
  }

  status(): Record<string, unknown> {
    return { mode: 'extension', remote: true, closed: this.closed,
      ...(this.hostStatus ?? { connected: false, running: false, port: this.port ?? this.options.port ?? 19758, tab: null }) };
  }

  command<T>(command: Record<string, unknown>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new ThreadsError('DRIVER_CLOSED', 'The remote driver is closed.');
      if (!this.token || !this.port) throw new ThreadsError('BRIDGE_NOT_CONNECTED', 'Connect to the local bridge before issuing commands.');
      let body: string;
      try { body = JSON.stringify(command); } catch { throw new ThreadsError('INVALID_COMMAND', 'Command must be JSON serializable.'); }
      if (!body || Buffer.byteLength(body) > 64 * 1024) throw new ThreadsError('INVALID_COMMAND', 'Command exceeds the 64 KiB request limit.');
      const reply = await this.request('/command', 'POST', body);
      return reply.result as T;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private updateStatus(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const raw = value as Record<string, unknown>;
    if (typeof raw.connected !== 'boolean' || typeof raw.running !== 'boolean' || raw.port !== this.port) return;
    const tab = raw.tab && typeof raw.tab === 'object' ? raw.tab as Record<string, unknown> : null;
    this.hostStatus = { connected: raw.connected, running: raw.running, port: this.port!, pairingUrl: `http://127.0.0.1:${this.port}/`,
      tab: tab && Number.isInteger(tab.id) && typeof tab.url === 'string' ?
        { id: Number(tab.id), url: tab.url, ...(typeof tab.title === 'string' ? { title: tab.title.slice(0, 200) } : {}) } : null };
  }

  private async request(path: '/status' | '/command', method: 'GET' | 'POST', body?: string): Promise<Record<string, any>> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 35000);
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body,
      });
      if (response.status === 401) throw new ThreadsError('BRIDGE_AUTH_FAILED', 'Local bridge authentication failed; pairing may have changed.');
      if (response.status === 403) throw new ThreadsError('BRIDGE_ACCESS_DENIED', 'Local bridge rejected this native client.');
      let reply: Record<string, any>;
      try { reply = await response.json() as Record<string, any>; }
      catch { throw new ThreadsError('BRIDGE_INVALID_RESPONSE', 'Local bridge returned an invalid response.'); }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new ThreadsError('BRIDGE_INVALID_RESPONSE', 'Local bridge returned an invalid response.');
      this.updateStatus(reply.status);
      if (!response.ok || reply.error) {
        const code = typeof reply.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reply.error.code) ? reply.error.code : 'BRIDGE_COMMAND_FAILED';
        // Only the host's controlled error envelope is used; request bodies and tokens never appear.
        const message = code === 'BRIDGE_TIMEOUT' ? 'Browser command timed out. Its outcome may be unknown; it was not replayed.' :
          `Local bridge command failed (${code}). No command was replayed.`;
        throw new ThreadsError(code, message);
      }
      if (!this.hostStatus) throw new ThreadsError('BRIDGE_INVALID_RESPONSE', 'Local bridge did not supply valid status.');
      return reply;
    } catch (error) {
      if (error instanceof ThreadsError) throw error;
      if (this.closed) throw new ThreadsError('DRIVER_CLOSED', 'The remote driver closed; an in-flight command may have an unknown outcome.');
      if (controller.signal.aborted) throw new ThreadsError('BRIDGE_RPC_TIMEOUT', 'Local bridge request timed out. Its outcome may be unknown; it was not replayed.');
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        this.hostStatus = null;
        throw new ThreadsError('ECONNREFUSED', 'No local bridge is listening at the configured port.');
      }
      throw new ThreadsError('BRIDGE_RPC_FAILED', 'Local bridge request failed. Its outcome may be unknown; it was not replayed.');
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.token = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    // The shared host and user-selected browser tab remain running.
  }
}
