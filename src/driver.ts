import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BridgeServer } from './bridge.js';
import type { Config } from './config.js';
import { ThreadsError } from './types.js';
import { threadsUrl } from './urls.js';

export interface BrowserDriver {
  command<T>(command: Record<string, unknown>): Promise<T>;
  status(): unknown;
  close(): Promise<void>;
}

function validate(input: Record<string, unknown>): Record<string, unknown> {
  const command = { ...input };
  switch (command.type) {
    case 'navigate':
      if (typeof command.url !== 'string') throw new ThreadsError('INVALID_COMMAND', 'Navigation requires a Threads URL.');
      command.url = threadsUrl(command.url);
      break;
    case 'read': case 'snapshot': case 'screenshot': break;
    case 'social':
      if(!['stage','commit','inspect'].includes(String(command.operation)))throw new ThreadsError('INVALID_COMMAND','Unknown social operation.');
      break;
    case 'media':
      if(!['begin','chunk','finish','abort'].includes(String(command.operation)))throw new ThreadsError('INVALID_COMMAND','Unknown media operation.');
      break;
    case 'scroll':
      if (typeof command.pixels !== 'number' || !Number.isFinite(command.pixels) || Math.abs(command.pixels) > 10000)
        throw new ThreadsError('INVALID_COMMAND', 'Scroll pixels must be between -10000 and 10000.');
      break;
    case 'open_read_panel':
      if (!['followers', 'following', 'likers'].includes(String(command.panel))) throw new ThreadsError('INVALID_COMMAND', 'Unknown read panel.');
      if (command.activityTab !== undefined && (command.panel !== 'likers' || !['likes','reposts'].includes(String(command.activityTab)))) throw new ThreadsError('INVALID_COMMAND','Unknown post activity tab.');
      break;
    case 'interact':
      if (typeof command.snapshotId !== 'string' || !command.snapshotId || typeof command.ref !== 'string' || !command.ref ||
          !['click', 'fill', 'press', 'select', 'check'].includes(String(command.verb)) ||
          (command.value !== undefined && typeof command.value !== 'string' && typeof command.value !== 'boolean'))
        throw new ThreadsError('INVALID_COMMAND', 'Interaction requires a snapshot, reference and supported verb.');
      // The page runtime uses strings for checkbox state, too.
      if (typeof command.value === 'boolean') command.value = String(command.value);
      break;
    default: throw new ThreadsError('INVALID_COMMAND', 'Unsupported browser command.');
  }
  return command;
}

abstract class SerializedDriver implements BrowserDriver {
  protected closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  command<T>(input: Record<string, unknown>): Promise<T> {
    let command: Record<string, unknown>;
    try { command = validate(input); } catch (error) { return Promise.reject(error); }
    const result = this.queue.then(() => {
      if (this.closed) throw new ThreadsError('DRIVER_CLOSED', 'The browser driver is closed.');
      return this.execute(command) as Promise<T>;
    });
    // Failure does not replay a command, and does not poison subsequent reads.
    this.queue = result.catch(() => undefined);
    return result;
  }
  protected abstract execute(command: Record<string, unknown>): Promise<unknown>;
  abstract status(): unknown;
  abstract close(): Promise<void>;
}

export class ExtensionDriver extends SerializedDriver {
  constructor(private readonly bridge: BridgeServer) { super(); }
  protected execute(command: Record<string, unknown>): Promise<unknown> { return this.bridge.command(command); }
  status(): unknown { return { mode: 'extension', closed: this.closed, ...this.bridge.status() }; }
  async close(): Promise<void> { this.closed = true; await this.bridge.close(); }
}

export class DedicatedDriver extends SerializedDriver {
  private context?: BrowserContext;
  private page?: Page;
  private starting?: Promise<Page>;
  private stopped = false;
  private closingContext = false;

  constructor(private readonly config: Config) { super(); }

  status(): unknown {
    return { mode: 'dedicated', running: !!this.context, closed: this.closed, stopped: this.stopped,
      headless: this.config.headless, url: this.page && !this.page.isClosed() ? this.page.url() : null };
  }

  private async start(): Promise<Page> {
    if (this.stopped) throw new ThreadsError('BROWSER_CLOSED', 'The dedicated browser was closed. Start a new driver to continue.');
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private async launch(): Promise<Page> {
    let runtime: string;
    try { runtime = await readFile(fileURLToPath(new URL('../extension/runtime.js', import.meta.url)), 'utf8'); }
    catch { throw new ThreadsError('RUNTIME_NOT_BUILT', 'Build the browser runtime with node scripts/build-browser.mjs first.'); }
    const context = await chromium.launchPersistentContext(this.config.profileDir, {
      channel: this.config.channel, headless: this.config.headless, timeout: this.config.timeoutMs,
    });
    this.context = context;
    context.on('close', () => {
      if (this.context === context) { this.context = undefined; this.page = undefined; this.stopped = !this.closed && !this.closingContext; }
    });
    if (this.closed) { await context.close(); throw new ThreadsError('DRIVER_CLOSED', 'Driver closed during browser startup.'); }
    try {
      context.setDefaultTimeout(this.config.timeoutMs);
      context.setDefaultNavigationTimeout(this.config.timeoutMs);
      // Install once per document. Re-injecting on every call would erase snapshot references.
      await context.addInitScript({ content: runtime });
      const page = context.pages()[0] ?? await context.newPage();
      this.page = page;
      page.on('close', () => { if (this.page === page && !this.closed && !this.closingContext) this.stopped = true; });
      await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
      return page;
    } catch (error) {
      this.closingContext = true;
      try { await context.close().catch(() => undefined); } finally { this.closingContext = false; }
      throw error;
    }
  }

  protected async execute(command: Record<string, unknown>): Promise<unknown> {
    const page = await this.start();
    if (command.type === 'navigate') {
      await page.goto(command.url as string, { waitUntil: 'domcontentloaded' });
      threadsUrl(page.url());
      return { url: page.url(), title: await page.title() };
    }
    threadsUrl(page.url());
    if (command.type === 'screenshot') {
      const url = page.url();
      const buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
      if (url !== page.url()) throw new ThreadsError('PAGE_CHANGED', 'Page changed during capture; screenshot discarded.');
      return { dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`, url };
    }
    const response = await page.evaluate(async command => {
      const api = (globalThis as unknown as { ThreadsMCP?: {
        readPage(): unknown; snapshot(): unknown; interact(args: unknown): unknown;
        scroll(pixels: number): unknown; openReadPanel(panel: string,activityTab?:string): unknown;
        socialStage(request:unknown):unknown; socialCommit(token:string,expectedAccount:string):unknown; socialInspect(request:unknown,token?:string):unknown;media(command:unknown):unknown;
      } }).ThreadsMCP;
      if (!api) return { error: { code: 'RUNTIME_UNAVAILABLE', message: 'Browser runtime is unavailable in this document.' } };
      try {
        let result: unknown;
        switch (command.type) {
          case 'read': result = await api.readPage(); break;
          case 'snapshot': result = await api.snapshot(); break;
          case 'interact': result = await api.interact(command); break;
          case 'scroll': result = await api.scroll(command.pixels as number); break;
          case 'open_read_panel': result = await api.openReadPanel(command.panel as string,command.activityTab as string|undefined); break;
          case 'social': result = command.operation==='stage'?await api.socialStage(command.request):command.operation==='commit'?await api.socialCommit(command.token as string,command.expectedAccount as string):await api.socialInspect(command.request,command.token as string|undefined);break;
          case 'media': result=await api.media(command);break;
          default: throw new Error('INVALID_COMMAND: Unsupported command.');
        }
        return { result };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Page command failed.';
        const code = /^[A-Z_]+:/.exec(message)?.[0].slice(0, -1) || 'PAGE_COMMAND_FAILED';
        return { error: { code, message: message.slice(0, 1000) } };
      }
    }, command);
    if (response.error) throw new ThreadsError(response.error.code, response.error.message);
    return response.result;
  }

  /** Opens the dedicated profile visibly and waits for the user to close it. */
  async login(): Promise<void> {
    if (this.config.headless) throw new ThreadsError('HEADLESS_LOGIN', 'Manual login requires a headed dedicated browser.');
    await this.command({ type: 'navigate', url: 'https://www.threads.com/' });
    const context = this.context;
    if (context) await new Promise<void>(resolve => context.once('close', () => resolve()));
  }

  async close(): Promise<void> {
    this.closed = true;
    // Only this instance's launched context is closed. No existing Chrome connection is used.
    await this.context?.close();
    if (this.starting) await this.starting.catch(() => undefined);
  }
}

export async function loginDedicated(config: Config): Promise<void> {
  const driver = new DedicatedDriver({ ...config, headless: false });
  try { await driver.login(); } finally { await driver.close(); }
}
