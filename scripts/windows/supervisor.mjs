#!/usr/bin/env node
// Windows logon supervisor. Only ChildProcess objects created by this run are owned.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile, rename, stat, unlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = ['bridge', 'http', 'tunnel'];
const REMOTE_FLAGS = {
  remoteWritesEnabled: 'THREADS_REMOTE_ALLOW_WRITES', remoteMediaEnabled: 'THREADS_REMOTE_ALLOW_MEDIA',
  remoteExtendedReadsEnabled: 'THREADS_REMOTE_ALLOW_EXTENDED_READS', remoteDeleteEnabled: 'THREADS_REMOTE_ALLOW_DELETE',
  remoteScheduleEnabled: 'THREADS_REMOTE_ALLOW_SCHEDULE', remoteBrowserFallbackEnabled: 'THREADS_REMOTE_ALLOW_BROWSER_FALLBACK',
  remoteMessagesEnabled: 'THREADS_REMOTE_ALLOW_MESSAGES', remoteOfficialApiEnabled: 'THREADS_REMOTE_ALLOW_OFFICIAL_API',
};
const CAPABILITY_FIELDS = {
  extendedReads: 'remoteExtendedReadsEnabled', delete: 'remoteDeleteEnabled', schedule: 'remoteScheduleEnabled',
  browserFallback: 'remoteBrowserFallbackEnabled', messages: 'remoteMessagesEnabled', officialApi: 'remoteOfficialApiEnabled',
};
const WRITE_DEPENDENT_FLAGS = ['remoteMediaEnabled', 'remoteDeleteEnabled', 'remoteScheduleEnabled', 'remoteBrowserFallbackEnabled', 'remoteOfficialApiEnabled'];
const CONFIG_FIELDS = new Set(['schemaVersion', 'projectDir', 'dataDir', 'nodePath', 'cloudflaredPath', 'bridgePort', 'httpPort', 'metricsPort', 'hostname', 'tunnelTokenFile', 'tunnelEnabled', ...Object.keys(REMOTE_FLAGS), 'checkIntervalMs', 'healthTimeoutMs', 'restartBaseMs', 'restartMaxMs', 'stableResetMs', 'maxEventLogBytes']);
const BRIDGE_STATES = new Set(['unchecked', 'connected', 'extension-disconnected', 'host-unreachable', 'pairing-missing', 'auth-failed', 'pairing-invalid', 'closed']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const safePath = value => typeof value === 'string' && isAbsolute(value) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)) && !/[\x00-\x1f"]/.test(value);
const numeric = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const remoteFlags = config => Object.fromEntries(Object.keys(REMOTE_FLAGS).map(key => [key, config[key] === true]));
const remoteCapabilities = config => Object.fromEntries(Object.entries(CAPABILITY_FIELDS).map(([key, field]) => [key, config[field] === true]));
function sanitizedCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(CAPABILITY_FIELDS).some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'boolean')) return null;
  return Object.fromEntries(Object.keys(CAPABILITY_FIELDS).map(key => [key, value[key]]));
}
function capabilitiesMatch(value, expected) {
  if (value === undefined) return Object.values(expected).every(enabled => !enabled);
  const observed = sanitizedCapabilities(value);
  return !!observed && Object.keys(expected).every(key => observed[key] === expected[key]);
}

export async function loadConfig(configPath) {
  configPath = resolve(configPath);
  let input;
  try { const raw = await readFile(configPath, 'utf8'); if (Buffer.byteLength(raw) > 16384) fail('CONFIG_INVALID'); input = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') fail('CONFIG_MISSING'); fail('CONFIG_INVALID'); }
  return validateConfig(input, configPath);
}

export function validateConfig(input, configPath) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !CONFIG_FIELDS.has(key))) fail('CONFIG_INVALID');
  if (input.schemaVersion !== 1 || !['projectDir', 'dataDir', 'nodePath', 'tunnelTokenFile'].every(key => safePath(input[key]))) fail('CONFIG_INVALID');
  if (typeof input.tunnelEnabled !== 'boolean' || typeof input.hostname !== 'string' || typeof input.cloudflaredPath !== 'string') fail('CONFIG_INVALID');
  if (Object.keys(REMOTE_FLAGS).some(key => Object.hasOwn(input, key) && typeof input[key] !== 'boolean')) fail('CONFIG_INVALID');
  if (input.remoteWritesEnabled !== true && WRITE_DEPENDENT_FLAGS.some(key => input[key] === true)) fail('CONFIG_INVALID');
  if (input.cloudflaredPath !== '' && !safePath(input.cloudflaredPath)) fail('CONFIG_INVALID');
  const stateDir = join(resolve(input.dataDir), 'remote-host');
  if (resolve(dirname(configPath)).toLowerCase() !== stateDir.toLowerCase() || dirname(resolve(input.tunnelTokenFile)).toLowerCase() !== stateDir.toLowerCase()) fail('PRIVATE_PATH_REQUIRED');
  const ports = [input.bridgePort, input.httpPort, input.metricsPort];
  if (ports.some(port => !numeric(port, 1024, 65535)) || new Set(ports).size !== 3 || input.httpPort === 19758 || input.metricsPort === 19758) fail('PORT_CONFIG_INVALID');
  if (input.hostname !== '' && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.hostname) || input.hostname.endsWith('.localhost'))) fail('HOSTNAME_INVALID');
  if (input.tunnelEnabled && (!input.hostname || !input.cloudflaredPath)) fail('TUNNEL_CONFIG_INCOMPLETE');
  if (!numeric(input.checkIntervalMs, 1000, 60000) || !numeric(input.healthTimeoutMs, 5000, 15000) || !numeric(input.restartBaseMs, 500, 60000) ||
      !numeric(input.restartMaxMs, input.restartBaseMs, 600000) || !numeric(input.stableResetMs, 10000, 3600000) || !numeric(input.maxEventLogBytes, 16384, 1048576)) fail('CONFIG_INVALID');
  return Object.freeze({ ...input, ...remoteFlags(input), configPath: resolve(configPath), stateDir });
}

export function childEnvironment(config, source = process.env, service) {
  // API configuration is forwarded only to the explicitly enabled HTTP service.
  // Never inherit allow flags, TUNNEL_TOKEN, log/config overrides or NODE_OPTIONS.
  const allowed = /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.test(key) && typeof value === 'string'));
  if (service === 'http' && config.remoteOfficialApiEnabled === true) {
    for (const name of ['THREADS_API_ACCESS_TOKEN', 'THREADS_API_USER_ID']) if (typeof source[name] === 'string') env[name] = source[name];
  }
  return { ...env, THREADS_DATA_DIR: config.dataDir, THREADS_BRIDGE_PORT: String(config.bridgePort), THREADS_HTTP_PORT: String(config.httpPort), THREADS_PROVIDER: 'extension', THREADS_ALLOW_WRITES: 'false',
    ...Object.fromEntries(Object.entries(REMOTE_FLAGS).map(([key, name]) => [name, config[key] === true ? 'true' : 'false'])) };
}

export function commandFor(config, service) {
  if (service === 'bridge' || service === 'http') return { executable: config.nodePath, args: [join(config.projectDir, 'dist', 'cli.js'), service === 'bridge' ? 'bridge' : 'serve-http'] };
  if (service !== 'tunnel') fail('SERVICE_INVALID');
  // No --url or local ingress. The managed hostname must be configured externally
  // to http://127.0.0.1:<httpPort>, with that same HTTP Host Header, never bridgePort.
  return { executable: config.cloudflaredPath, args: ['tunnel', '--config', join(config.stateDir, 'cloudflared-supervisor.yml'), '--no-autoupdate', '--metrics', `127.0.0.1:${config.metricsPort}`, 'run', '--token-file', config.tunnelTokenFile] };
}

export function portAvailable(port) {
  return new Promise(resolvePromise => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolvePromise(true)));
  });
}

export function probePort(port, timeoutMs = 1000) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port }); let timer; let settled = false;
    const done = (listening, state) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolvePromise({ port, listening, state }); };
    socket.once('connect', () => done(true, 'accepting-loopback-tcp'));
    socket.once('error', error => done(error.code === 'ECONNREFUSED' ? false : null, error.code === 'ECONNREFUSED' ? 'connection-refused' : 'unavailable'));
    timer = setTimeout(() => done(null, 'timeout'), timeoutMs);
  });
}

export function requestStatus(url, { token, timeoutMs = 2000, maxBytes = 32768 } = {}) {
  return new Promise(resolvePromise => {
    const parsed = new URL(url); const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false; let timer;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(result); } };
    const req = client(parsed, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { req.destroy(); done({ code: 'RESPONSE_TOO_LARGE' }); } else chunks.push(chunk); });
      res.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Status may have no JSON body. */ }
        done({ status: res.statusCode, body });
      });
      res.on('error', () => done({ code: 'UNREACHABLE' }));
    });
    timer = setTimeout(() => { req.destroy(); done({ code: 'TIMEOUT' }); }, timeoutMs);
    req.on('error', () => done({ code: 'UNREACHABLE' }));
    req.end();
  });
}

async function readSmall(path, limit) {
  const info = await stat(path); if (!info.isFile() || info.size > limit) fail('PRIVATE_FILE_INVALID');
  return readFile(path, 'utf8');
}

export async function probeService(config, service) {
  const options = { timeoutMs: config.healthTimeoutMs };
  if (service === 'bridge') {
    let pairing;
    try { pairing = JSON.parse(await readSmall(join(config.dataDir, 'bridge-pairing.json'), 16384)); }
    catch (error) { return { state: error.code === 'ENOENT' ? 'pairing-missing' : 'pairing-invalid', browserConnected: false }; }
    if (pairing.port !== config.bridgePort || typeof pairing.token !== 'string' || !/^[a-f0-9]{64}$/.test(pairing.token)) return { state: 'pairing-invalid', browserConnected: false };
    const result = await requestStatus(`http://127.0.0.1:${config.bridgePort}/status`, { ...options, token: pairing.token });
    if (result.status === 401) return { state: 'auth-failed', browserConnected: false };
    if (result.status !== 200 || result.body?.status?.port !== config.bridgePort || result.body?.status?.running !== true || typeof result.body?.status?.connected !== 'boolean')
      return { state: result.code ? 'host-unreachable' : 'unexpected-response', browserConnected: false };
    return { state: 'host-up', browserConnected: result.body.status.connected };
  }
  if (service === 'http') {
    let token;
    try { token = (await readSmall(join(config.dataDir, 'remote-access.token'), 512)).trim(); }
    catch (error) {
      const result = await requestStatus(`http://127.0.0.1:${config.httpPort}/healthz`, options);
      return { state: result.status === 503 ? 'access-disabled' : result.code ? 'host-unreachable' : error.code === 'ENOENT' ? 'access-token-missing' : 'access-token-invalid', browserConnected: false };
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return { state: 'access-token-invalid', browserConnected: false };
    const result = await requestStatus(`http://127.0.0.1:${config.httpPort}/healthz`, { ...options, token });
    if (result.status === 503) return { state: 'access-disabled', browserConnected: false };
    if (result.status === 401) return { state: 'auth-failed', browserConnected: false };
    const body = result.body;
    const remoteWritesEnabled = config.remoteWritesEnabled === true;
    const remoteMediaEnabled = config.remoteMediaEnabled === true;
    const capabilities = remoteCapabilities(config);
    const expectedService = remoteWritesEnabled ? 'threads-mcp-controlled' : 'threads-mcp-readonly';
    if (result.status !== 200 || body?.service !== expectedService || body?.revision !== 'remote-health-1' || body?.http !== 'up' || !BRIDGE_STATES.has(body?.bridge?.state) || typeof body?.browser?.connected !== 'boolean' ||
        (body.writesEnabled !== undefined && body.writesEnabled !== remoteWritesEnabled) || (remoteWritesEnabled && body.writesEnabled !== true) ||
        (body.mediaEnabled !== undefined && body.mediaEnabled !== remoteMediaEnabled) || (remoteMediaEnabled && body.mediaEnabled !== true) || !capabilitiesMatch(body.capabilities, capabilities))
      return { state: result.code ? 'host-unreachable' : 'unexpected-response', browserConnected: false };
    return { state: 'http-up', remoteWritesEnabled, remoteMediaEnabled, capabilities, bridgeState: body.bridge.state, browserConnected: body.browser.connected, busy: body.busy === true, externalPath: 'not-probed' };
  }
  const result = await requestStatus(`http://127.0.0.1:${config.metricsPort}/ready`, options);
  return { state: result.status === 200 ? 'edge-ready' : result.code ? 'metrics-unreachable' : 'edge-not-ready', endToEndVerified: false };
}

export async function publicAnonymousProbe(config) {
  if (!config.hostname) return { state: 'not-configured', authenticatedReadVerified: false };
  // Deliberately no Authorization and no redirects, so a secret cannot leave loopback.
  const result = await requestStatus(`https://${config.hostname}/mcp`, { timeoutMs: config.healthTimeoutMs, maxBytes: 65536 });
  return { state: result.status === 401 ? 'anonymous-rejected' : result.status === 503 ? 'access-disabled-or-origin-unavailable' : result.code ? 'unreachable' : 'unexpected-status', status: result.status ?? null, authenticatedReadVerified: false };
}

export class Supervisor {
  constructor(config, dependencies = {}) {
    this.config = config; this.stopping = false;
    this.now = dependencies.now ?? Date.now;
    this.spawn = dependencies.spawn ?? ((command, args, options) => spawn(command, args, options));
    this.available = dependencies.portAvailable ?? portAvailable;
    this.probe = dependencies.probe ?? (service => probeService(config, service));
    this.canLaunchTunnel = dependencies.canLaunchTunnel ?? (async () => exists(config.tunnelTokenFile));
    this.shouldStop = dependencies.shouldStop ?? (async () => false);
    this.event = dependencies.event ?? (() => {});
    this.records = Object.fromEntries(SERVICES.map(name => [name, { name, child: null, process: 'stopped', failures: 0, nextStartAt: 0, startedAt: 0, external: false, health: { state: 'unchecked' } }]));
  }
  changed(record, state) {
    if (record.process !== state) { record.process = state; this.event({ event: 'process-state', service: record.name, state }); }
  }
  died(record, child, code) {
    if (record.child !== child) return;
    record.child = null;
    if (this.stopping) { this.changed(record, 'stopped'); return; }
    record.failures++;
    const backoffMs = Math.min(this.config.restartMaxMs, this.config.restartBaseMs * 2 ** Math.min(record.failures - 1, 20));
    record.nextStartAt = this.now() + backoffMs;
    this.changed(record, 'backoff');
    this.event({ event: 'child-exited', service: record.name, exitCode: Number.isInteger(code) ? code : null, attempt: record.failures, backoffMs });
  }
  async tick() {
    for (const service of SERVICES) {
      if (this.stopping || await this.shouldStop()) { this.stopping = true; break; }
      const record = this.records[service];
      if (service === 'tunnel' && !this.config.tunnelEnabled) { this.changed(record, 'disabled'); continue; }
      if (record.child) {
        record.health = await this.probe(service);
        // An alive process is never restarted for a disconnected tab, revoked token,
        // missing readiness, or network outage. Reconnection stays application-owned.
        if (['host-up', 'http-up', 'edge-ready'].includes(record.health.state) && this.now() - record.startedAt >= this.config.stableResetMs) record.failures = 0;
        continue;
      }
      if (record.external) {
        record.health = await this.probe(service);
        this.changed(record, 'external-unmanaged');
        continue; // Never adopt or resurrect a process first observed as unowned.
      }
      if (this.now() < record.nextStartAt) { this.changed(record, 'backoff'); continue; }
      const port = service === 'bridge' ? this.config.bridgePort : service === 'http' ? this.config.httpPort : this.config.metricsPort;
      if (!await this.available(port)) {
        record.external = true; record.health = await this.probe(service); this.changed(record, 'external-unmanaged'); continue;
      }
      if (service === 'tunnel') {
        if (!await this.canLaunchTunnel()) { this.changed(record, 'token-file-missing'); continue; }
        const http = await this.probe('http');
        if (http.state !== 'http-up') { this.changed(record, 'waiting-for-authenticated-http'); continue; }
      }
      if (this.stopping || await this.shouldStop()) { this.stopping = true; break; }
      const command = commandFor(this.config, service);
      let child;
      try {
        child = this.spawn(command.executable, command.args, { cwd: this.config.projectDir, env: childEnvironment(this.config, process.env, service), windowsHide: true, shell: false, stdio: 'ignore' });
      } catch { record.failures++; record.nextStartAt = this.now() + Math.min(this.config.restartMaxMs, this.config.restartBaseMs * 2 ** Math.min(record.failures - 1, 20)); this.changed(record, 'spawn-failed'); continue; }
      record.child = child; record.startedAt = this.now(); this.changed(record, 'running');
      child.once('error', () => this.died(record, child, null));
      child.once('exit', code => this.died(record, child, code));
      this.event({ event: 'child-started', service, pid: Number.isInteger(child.pid) ? child.pid : null });
    }
    return this.snapshot();
  }
  snapshot() {
    return { stopping: this.stopping, services: Object.fromEntries(SERVICES.map(service => {
      const record = this.records[service];
      return [service, { process: record.process, ownership: record.child ? 'owned-this-run' : record.external ? 'external-unmanaged' : 'none', pid: record.child?.pid ?? null, failures: record.failures, nextStartAt: record.nextStartAt ? new Date(record.nextStartAt).toISOString() : null, health: record.health }];
    })) };
  }
  async stop() {
    this.stopping = true;
    for (const service of [...SERVICES].reverse()) {
      const record = this.records[service]; const child = record.child;
      if (!child) continue;
      // No PID enumeration, process-name matching, taskkill, or process-tree sweep.
      try { child.kill(); } catch { /* The owned child may have exited already. */ }
    }
  }
}

export function lockName(config) {
  const hash = createHash('sha256').update(config.configPath.toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\threads-mcp-remote-host-${hash}` : join(config.stateDir, `supervisor-${hash}.sock`);
}
async function acquireLock(config) {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolvePromise, reject) => { server.once('error', () => reject(Object.assign(new Error('SUPERVISOR_ALREADY_RUNNING'), { code: 'SUPERVISOR_ALREADY_RUNNING' }))); server.listen(lockName(config), resolvePromise); });
  return server;
}
async function lockActive(config) {
  return new Promise(resolvePromise => {
    const socket = connect(lockName(config));
    const done = value => { socket.destroy(); resolvePromise(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(false));
  });
}
async function atomicJson(path, value) {
  const pending = `${path}.next`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(pending, path);
}
async function appendEvent(config, event) {
  // All callers supply only fixed enum strings, timestamps, numeric PIDs/codes.
  const path = join(config.stateDir, 'events.jsonl');
  try { if ((await stat(path)).size >= config.maxEventLogBytes) await rename(path, join(config.stateDir, 'events.previous.jsonl')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function assertFiles(config, requireTunnelToken = false) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('NODE_VERSION_UNSUPPORTED');
  for (const path of [config.nodePath, join(config.projectDir, 'dist', 'cli.js'), ...(config.tunnelEnabled ? [config.cloudflaredPath] : [])]) {
    try { if (!(await stat(path)).isFile()) fail('EXECUTABLE_MISSING'); } catch { fail('EXECUTABLE_MISSING'); }
  }
  if ((await realpath(config.stateDir)).toLowerCase() !== resolve(config.stateDir).toLowerCase()) fail('PRIVATE_PATH_REPARSE_POINT');
  if (config.tunnelEnabled && requireTunnelToken && !await exists(config.tunnelTokenFile)) fail('TUNNEL_TOKEN_FILE_MISSING');
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED');
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await new Promise(resolvePromise => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'Assert-PrivatePaths.ps1'), '-StateDir', config.stateDir, '-ConfigPath', config.configPath, '-TokenFile', config.tunnelTokenFile], { windowsHide: true, shell: false, stdio: 'ignore', env: childEnvironment(config) });
    let settled = false; let timer;
    const done = valid => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(valid); } };
    timer = setTimeout(() => { try { child.kill(); } catch { /* Only this owned validation child. */ } done(false); }, 5000);
    child.once('error', () => done(false)); child.once('exit', code => done(code === 0));
  });
  if (!result) fail('PRIVATE_ACL_REQUIRED');
}

async function assertStartPrerequisites(config) {
  await assertFiles(config);
  // Provisioning is explicit. Never create an initially unprotected bearer as a
  // side effect of logon. A revocation marker permits missing-token HTTP 503.
  if (!await exists(join(config.dataDir, 'remote-access.token')) && !await exists(join(config.dataDir, 'remote-access.initialized'))) fail('REMOTE_TOKEN_SETUP_REQUIRED');
}

function sanitizedSnapshot(input) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(input.runId ?? '') || !Number.isInteger(input.supervisorPid) || !Number.isFinite(Date.parse(input.updatedAt))) return null;
  const states = new Set(['stopped', 'disabled', 'running', 'backoff', 'spawn-failed', 'external-unmanaged', 'token-file-missing', 'waiting-for-authenticated-http']);
  const healthStates = new Set(['unchecked', 'pairing-missing', 'pairing-invalid', 'auth-failed', 'host-unreachable', 'unexpected-response', 'host-up', 'http-up', 'access-disabled', 'access-token-missing', 'access-token-invalid', 'edge-ready', 'metrics-unreachable', 'edge-not-ready']);
  const services = {};
  for (const service of SERVICES) {
    const source = input.services?.[service]; if (!source || !states.has(source.process)) return null;
    const capabilities = sanitizedCapabilities(source.health?.capabilities);
    services[service] = { process: source.process, ownership: ['owned-this-run', 'external-unmanaged', 'none'].includes(source.ownership) ? source.ownership : 'none', pid: Number.isInteger(source.pid) ? source.pid : null,
      failures: numeric(source.failures, 0, 1_000_000) ? source.failures : 0, nextStartAt: typeof source.nextStartAt === 'string' && Number.isFinite(Date.parse(source.nextStartAt)) ? new Date(source.nextStartAt).toISOString() : null,
      health: { state: healthStates.has(source.health?.state) ? source.health.state : 'unchecked', ...(typeof source.health?.browserConnected === 'boolean' ? { browserConnected: source.health.browserConnected } : {}),
        ...(typeof source.health?.remoteWritesEnabled === 'boolean' ? { remoteWritesEnabled: source.health.remoteWritesEnabled } : {}),
        ...(typeof source.health?.remoteMediaEnabled === 'boolean' ? { remoteMediaEnabled: source.health.remoteMediaEnabled } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(BRIDGE_STATES.has(source.health?.bridgeState) ? { bridgeState: source.health.bridgeState } : {}), ...(typeof source.health?.busy === 'boolean' ? { busy: source.health.busy } : {}) } };
  }
  return { schemaVersion: 1, runId: input.runId, supervisorPid: input.supervisorPid, updatedAt: new Date(input.updatedAt).toISOString(), stopping: input.stopping === true, services };
}

export async function diagnose(config, { checkPublic = false } = {}) {
  let saved = null;
  try {
    const input = JSON.parse(await readSmall(join(config.stateDir, 'status.json'), 65536));
    saved = sanitizedSnapshot(input);
  } catch { /* No prior supervisor run is normal. */ }
  const running = await lockActive(config);
  const probes = Object.fromEntries(await Promise.all(SERVICES.map(async service => [service, service === 'tunnel' && !config.tunnelEnabled ? { state: 'disabled' } : await probeService(config, service)])));
  const ports = Object.fromEntries(await Promise.all([['bridge', config.bridgePort], ['http', config.httpPort], ['metrics', config.metricsPort]].map(async ([name, port]) => [name, await probePort(port)])));
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), ports, supervisor: { running, stoppedByRequest: await exists(join(config.stateDir, 'stopped.json')), snapshotFresh: running && !!saved && Date.now() - Date.parse(saved.updatedAt) < Math.max(30000, config.checkIntervalMs * 4), snapshotProcessIdentityVerified: false, snapshot: saved },
    config: { bridgePort: config.bridgePort, httpPort: config.httpPort, metricsPort: config.metricsPort, tunnelEnabled: config.tunnelEnabled, ...remoteFlags(config), hostname: config.hostname, expectedManagedOrigin: `http://127.0.0.1:${config.httpPort}`, expectedOriginHostHeader: `127.0.0.1:${config.httpPort}`, managedIngressVerified: false },
    health: probes, ...(checkPublic ? { publicAnonymous: await publicAnonymousProbe(config) } : { publicAnonymous: { state: 'not-probed', authenticatedReadVerified: false } }) };
}

async function run(config) {
  if (await exists(join(config.stateDir, 'stopped.json'))) return;
  await assertStartPrerequisites(config);
  const lock = await acquireLock(config); const runId = randomUUID();
  let requestedStop = false; let eventQueue = Promise.resolve();
  const event = value => { eventQueue = eventQueue.then(() => appendEvent(config, value)); eventQueue.catch(() => { requestedStop = true; }); };
  const supervisor = new Supervisor(config, { event, shouldStop: async () => requestedStop || await exists(join(config.stateDir, 'stopped.json')), canLaunchTunnel: async () => { if (!await exists(config.tunnelTokenFile)) return false; await assertFiles(config, true); return true; } });
  const stop = () => { requestedStop = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await writeFile(join(config.stateDir, 'cloudflared-supervisor.yml'), `# No local ingress; the fixed hostname is managed in Cloudflare.\nmetrics: 127.0.0.1:${config.metricsPort}\nno-autoupdate: true\n`, { mode: 0o600 });
    event({ event: 'supervisor-started', pid: process.pid });
    while (!requestedStop && !await exists(join(config.stateDir, 'stopped.json'))) {
      const snapshot = await supervisor.tick();
      await atomicJson(join(config.stateDir, 'status.json'), { schemaVersion: 1, runId, supervisorPid: process.pid, updatedAt: new Date().toISOString(), ...snapshot });
      await eventQueue;
      const until = Date.now() + config.checkIntervalMs;
      while (!requestedStop && Date.now() < until && !await exists(join(config.stateDir, 'stopped.json'))) await sleep(250);
    }
  } finally {
    await finalizeRun({
      stopChildren: () => supervisor.stop(),
      persistFinal: async () => { await sleep(200); await atomicJson(join(config.stateDir, 'status.json'), { schemaVersion: 1, runId, supervisorPid: process.pid, updatedAt: new Date().toISOString(), ...supervisor.snapshot() }); },
      flushEvents: async () => { event({ event: 'supervisor-stopped' }); await eventQueue.catch(() => {}); },
      release: async () => {
        try { await new Promise(resolvePromise => lock.close(resolvePromise)); }
        finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      },
    });
  }
}

export async function finalizeRun({ stopChildren, persistFinal, flushEvents, release }) {
  // Disk/ACL failure must not leave an idle lock server keeping the supervisor
  // alive after its children stopped. Cleanup is independent of result recording.
  try { await stopChildren(); await persistFinal(); }
  finally { try { await flushEvents(); } finally { await release(); } }
}

async function main() {
  const [action, flag, path, optional] = process.argv.slice(2);
  if (!['validate', 'run', 'status', 'stop', 'resume'].includes(action) || flag !== '--config' || !path || (optional !== undefined && optional !== '--check-public')) fail('USAGE_INVALID');
  const config = await loadConfig(path);
  if (action === 'validate') { await assertFiles(config); console.log(JSON.stringify({ valid: true, tunnelEnabled: config.tunnelEnabled, ...remoteFlags(config), tunnelTokenFilePresent: await exists(config.tunnelTokenFile) })); return; }
  if (action === 'status') { console.log(JSON.stringify(await diagnose(config, { checkPublic: optional === '--check-public' }), null, 2)); return; }
  if (action === 'stop') { await atomicJson(join(config.stateDir, 'stopped.json'), { schemaVersion: 1, requestedAt: new Date().toISOString() }); console.log(JSON.stringify({ stopRequested: true, persistent: true })); return; }
  if (action === 'resume') { await assertStartPrerequisites(config); try { await unlink(join(config.stateDir, 'stopped.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; } console.log(JSON.stringify({ stopRequestCleared: true })); return; }
  await run(config);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SUPERVISOR_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
});
