import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ThreadsError } from './types.js';
import { validateDirectProfileCommand } from './direct-profile-command.js';
import { validateRemoteBrowserCommand } from './remote-browser-runtime.js';

interface BridgeOptions { dataDir: string; port?: number; commandTimeoutMs?: number; authTimeoutMs?: number }
interface BoundTab { id: number; url: string; title?: string }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const MAX_PAYLOAD = 4 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exactCommand(command: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(command).length === fields.length && fields.every(key => Object.hasOwn(command, key));
}

export function isThreadsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      ['threads.com', 'threads.net'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function validateCommand(command: Record<string, unknown>): void {
  if (!command || typeof command !== 'object' || JSON.stringify(command).length > 64 * 1024) throw new ThreadsError('INVALID_COMMAND', 'Invalid bridge command.');
  switch (command.type) {
    case 'navigate':
      if (!isThreadsUrl(command.url)) throw new ThreadsError('INVALID_URL', 'Navigation must remain on an HTTPS Threads page.');
      break;
    case 'read': case 'snapshot': case 'screenshot': break;
    case 'direct_profile': validateDirectProfileCommand(command); break;
    case 'remote_browser':
      try { validateRemoteBrowserCommand(command); }
      catch { throw new ThreadsError('INVALID_COMMAND', 'Invalid remote browser command.'); }
      break;
    case 'remote_view':
      if (!exactCommand(command, ['type','kind','expectedAccount','navigationToken']) ||
          !['for_you','following','saved','liked','notifications','messages'].includes(String(command.kind)) ||
          typeof command.expectedAccount !== 'string' || !/^@?[A-Za-z0-9_.]{1,30}$/.test(command.expectedAccount) ||
          typeof command.navigationToken !== 'string' || !uuid.test(command.navigationToken))
        throw new ThreadsError('INVALID_COMMAND', 'Invalid fixed remote view command.');
      break;
    case 'social':
      if(!['stage','commit','inspect','prepare_confirmation','commit_confirmation'].includes(String(command.operation)))throw new ThreadsError('INVALID_COMMAND','Unknown social operation.');
      if (command.operation === 'prepare_confirmation' || command.operation === 'commit_confirmation') {
        const token = command.operation === 'prepare_confirmation' ? 'sourceToken' : 'token';
        if (!exactCommand(command, ['type','operation',token,'expectedAccount']) ||
            typeof command[token] !== 'string' || !uuid.test(command[token]) ||
            typeof command.expectedAccount !== 'string' || !/^@?[A-Za-z0-9_.]{1,64}$/.test(command.expectedAccount))
          throw new ThreadsError('INVALID_COMMAND', 'Invalid bound social confirmation command.');
      }
      break;
    case 'media':
      if(!['begin','chunk','finish','abort'].includes(String(command.operation)))throw new ThreadsError('INVALID_COMMAND','Unknown media operation.');
      break;
    case 'scroll':
      if (typeof command.pixels !== 'number' || !Number.isFinite(command.pixels) || Math.abs(command.pixels) > 10000) throw new ThreadsError('INVALID_COMMAND', 'Scroll pixels must be between -10000 and 10000.');
      break;
    case 'open_read_panel':
      if (!['followers', 'following', 'likers'].includes(String(command.panel))) throw new ThreadsError('INVALID_COMMAND', 'Unknown read panel.');
      break;
    case 'interact':
      if (typeof command.snapshotId !== 'string' || !command.snapshotId || typeof command.ref !== 'string' || !command.ref ||
        !['click', 'fill', 'press', 'select', 'check'].includes(String(command.verb)) ||
        (command.value !== undefined && typeof command.value !== 'string' && typeof command.value !== 'boolean')) {
        throw new ThreadsError('INVALID_COMMAND', 'Interaction requires a snapshot, reference and allowed verb.');
      }
      break;
    default: throw new ThreadsError('INVALID_COMMAND', 'Unsupported bridge command.');
  }
}

export class BridgeServer {
  private readonly token = randomBytes(32).toString('hex');
  private readonly options: BridgeOptions;
  private readonly pairingFile: string;
  private server?: Server;
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private tab?: BoundTab;
  private port: number;
  private pending = new Map<string, Pending>();
  private running = false;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.port = options.port ?? 19758;
    this.pairingFile = join(options.dataDir, 'bridge-pairing.json');
  }

  status(): { connected: boolean; running: boolean; port: number; pairingUrl: string; tab: BoundTab | null } {
    return { connected: this.socket?.readyState === WebSocket.OPEN, running: this.running, port: this.port,
      pairingUrl: `http://127.0.0.1:${this.port}/`, tab: this.tab ?? null };
  }

  private validHost(req: IncomingMessage): boolean { return req.headers.host === `127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    if (this.running) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this.server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      const origin = req.headers.origin;
      if (!this.validHost(req) || req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `http://127.0.0.1:${this.port}`)) {
        res.writeHead(403).end('Forbidden'); return;
      }
      if (req.url === '/status' || req.url === '/command') {
        void this.rpc(req, res); return;
      }
      if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end('Not found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Threads MCP 配對</title>
        <style>body{font:16px system-ui;max-width:620px;margin:60px auto;padding:24px;background:#151515;color:#eee}input{width:100%;box-sizing:border-box;padding:12px;font:14px monospace}li{margin:12px 0}p{line-height:1.7}</style>
        <h1>連接目前的 Threads 分頁</h1><ol><li>在 Chrome 載入專案的 extension 資料夾。</li><li>切換到你已登入的 Threads 分頁，按擴充功能圖示。</li><li>連接埠填入 ${this.port}，貼上以下配對碼，按「連接此分頁」。</li></ol>
        <label for="token">配對碼（點選欄位後 Ctrl+A、Ctrl+C 複製）</label><input id="token" readonly value="${this.token}" autocomplete="off">
        <p>配對碼只供這次本機服務使用；不要分享。連線只綁定你選取的分頁，不會讀取 Cookie。隨時可在擴充功能中斷線。</p></html>`);
    });
    this.server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin ?? '';
      if (!this.validHost(req) || req.url !== '/bridge' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      this.wss!.handleUpgrade(req, socket, head, ws => this.accept(ws));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        const address = this.server!.address();
        if (address && typeof address !== 'string') this.port = address.port;
        resolve();
      });
    });
    this.running = true;
    mkdirSync(this.options.dataDir, { recursive: true });
    writeFileSync(this.pairingFile, JSON.stringify({ port: this.port, token: this.token, url: this.status().pairingUrl }, null, 2), { mode: 0o600 });
  }

  private authenticatedRequest(req: IncomingMessage): boolean {
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status: number, body: unknown) => { if (!res.destroyed && !res.writableEnded) res.writeHead(status).end(JSON.stringify(body)); };
    if (req.headers.origin !== undefined) { send(403, { error: { code: 'BRIDGE_ORIGIN_REJECTED', message: 'RPC accepts native local clients only.' } }); return; }
    if (!this.authenticatedRequest(req)) { send(401, { error: { code: 'BRIDGE_AUTH_FAILED', message: 'Local bridge authentication failed.' } }); return; }
    if (req.url === '/status' && req.method === 'GET') { send(200, { status: this.status() }); return; }
    if (req.url !== '/command' || req.method !== 'POST') { send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET /status or POST /command.' } }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      req.resume(); send(415, { error: { code: 'INVALID_CONTENT_TYPE', message: 'Commands require application/json.' } }); return;
    }
    try {
      const command = await this.readCommandBody(req);
      const result = await this.command(command);
      send(200, { result, status: this.status() });
    } catch (error) {
      // Never echo arbitrary exception messages, page text or request contents to the RPC client.
      const rawCode = error instanceof ThreadsError ? error.code : 'BRIDGE_COMMAND_FAILED';
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'BRIDGE_COMMAND_FAILED';
      const message = code === 'BRIDGE_TIMEOUT' ? 'Browser command timed out. Its outcome may be unknown; it was not replayed.' :
        code === 'BRIDGE_NOT_CONNECTED' || code === 'BRIDGE_DISCONNECTED' ? 'The selected Threads tab is not connected. No command was replayed.' :
        code === 'REQUEST_TOO_LARGE' ? 'Command exceeds the 64 KiB request limit.' :
        code === 'INVALID_JSON' ? 'Command body must be a JSON object.' :
        `Browser command failed (${code}). Inspect the current page before continuing; no command was replayed.`;
      const status = code === 'BRIDGE_TIMEOUT' ? 504 : code === 'REQUEST_TOO_LARGE' ? 413 :
        ['INVALID_JSON', 'INVALID_COMMAND', 'INVALID_URL'].includes(code) ? 400 :
        ['BRIDGE_NOT_CONNECTED', 'BRIDGE_DISCONNECTED', 'BRIDGE_BUSY'].includes(code) ? 503 : 502;
      send(status, { error: { code, message }, status: this.status() });
    }
  }

  private readCommandBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const pieces: Buffer[] = [];
      let size = 0;
      let finished = false;
      const timer = setTimeout(() => fail(new ThreadsError('INVALID_JSON', 'Request body timed out.')), 10000);
      const fail = (error: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); pieces.length = 0; req.resume(); reject(error);
      };
      req.on('data', (piece: Buffer) => {
        if (finished) return;
        size += piece.length;
        if (size > 64 * 1024) { fail(new ThreadsError('REQUEST_TOO_LARGE', 'Command too large.')); return; }
        pieces.push(piece);
      });
      req.on('end', () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(pieces).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
          resolve(value);
        } catch { reject(new ThreadsError('INVALID_JSON', 'Invalid JSON object.')); }
      });
      req.on('aborted', () => fail(new ThreadsError('INVALID_JSON', 'Request aborted.')));
      req.on('error', () => fail(new ThreadsError('INVALID_JSON', 'Request failed.')));
    });
  }

  private accept(ws: WebSocket): void {
    let authenticated = false;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), this.options.authTimeoutMs ?? 5000);
    ws.on('error', () => undefined);
    ws.on('message', data => {
      let message: Record<string, any>;
      try { message = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!message || typeof message !== 'object') { ws.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        const supplied = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
        const expected = Buffer.from(this.token);
        if (message.type !== 'auth' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
          !Number.isInteger(message.tab?.id) || !isThreadsUrl(message.tab?.url)) { ws.close(1008, 'Authentication failed'); return; }
        if (this.socket?.readyState === WebSocket.OPEN) { ws.close(1008, 'Another tab is already connected'); return; }
        clearTimeout(authTimer);
        authenticated = true;
        this.socket = ws;
        this.tab = { id: message.tab.id, url: message.tab.url, title: String(message.tab.title ?? '').slice(0, 200) };
        ws.send(JSON.stringify({ type: 'ready', tab: this.tab }));
        return;
      }
      if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (message.type === 'tab') {
        if (message.tab?.id !== this.tab?.id || !isThreadsUrl(message.tab?.url)) { ws.close(1008, 'Bound tab changed'); return; }
        this.tab = { id: message.tab.id, url: message.tab.url, title: String(message.tab.title ?? '').slice(0, 200) };
        return;
      }
      if (typeof message.id !== 'string') return;
      const pending = this.pending.get(message.id);
      if (!pending) return; // Late responses are ignored, never replayed.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new ThreadsError(String(message.error.code ?? 'BRIDGE_COMMAND_FAILED').slice(0, 100),
        String(message.error.message ?? 'Extension command failed.').slice(0, 1000)));
      else pending.resolve(message.result);
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (this.socket === ws) {
        this.socket = undefined; this.tab = undefined;
        this.rejectPending('BRIDGE_DISCONNECTED', 'The selected Threads tab disconnected. No command was replayed.');
      }
    });
  }

  command<T>(command: Record<string, unknown>): Promise<T> {
    try { validateCommand(command); } catch (error) { return Promise.reject(error); }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new ThreadsError('BRIDGE_NOT_CONNECTED', 'Connect the selected Threads tab with the extension first.'));
    if (this.pending.size >= 16) return Promise.reject(new ThreadsError('BRIDGE_BUSY', 'Too many outstanding browser commands.'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ThreadsError('BRIDGE_TIMEOUT', 'Browser command timed out. Its outcome may be unknown; it was not replayed.'));
      }, this.options.commandTimeoutMs ?? (command.type === 'direct_profile' ? 50000 : 30000));
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket!.send(JSON.stringify({ id, command }), error => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new ThreadsError('BRIDGE_SEND_FAILED', 'Could not send browser command. It was not replayed.')); }
        }
      });
    });
  }

  private rejectPending(code: string, message: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ThreadsError(code, message)); }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.running = false;
    this.rejectPending('BRIDGE_DISCONNECTED', 'Bridge closed. No command was replayed.');
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.socket = undefined; this.tab = undefined;
    this.wss?.close();
    if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
    try {
      const pairing = JSON.parse(readFileSync(this.pairingFile, 'utf8'));
      if (pairing.token === this.token) unlinkSync(this.pairingFile);
    } catch { /* File may already have been removed by the user. */ }
  }
}
