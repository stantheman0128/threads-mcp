import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// This standalone supervisor deliberately has no dependency on the built TS app.
import { Supervisor, validateConfig, loadConfig, commandFor, childEnvironment, requestStatus, probePort, probeService, diagnose, finalizeRun } from '../scripts/windows/supervisor.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(project, '.threads-data');
const sample = (dataDir = join(dataRoot, 'supervisor-fixture')) => ({
  schemaVersion: 1, projectDir: project, dataDir, nodePath: process.execPath, cloudflaredPath: join(project, 'fake-cloudflared.exe'),
  bridgePort: 19758, httpPort: 19759, metricsPort: 19760, hostname: 'threads.example.com', tunnelTokenFile: join(dataDir, 'remote-host', 'tunnel.token'), tunnelEnabled: false,
  checkIntervalMs: 5000, healthTimeoutMs: 5000, restartBaseMs: 1000, restartMaxMs: 4000, stableResetMs: 60000, maxEventLogBytes: 16384,
});
const configured = (overrides = {}) => { const input = { ...sample(), ...overrides }; return validateConfig(input, join(input.dataDir, 'remote-host', 'config.json')); };
let fakePid = 400000;
class FakeChild extends EventEmitter {
  pid = ++fakePid; killed = 0;
  kill() { this.killed++; this.emit('exit', 0); return true; }
}
const healthy = async (name: string) => ({ state: name === 'bridge' ? 'host-up' : name === 'http' ? 'http-up' : 'edge-ready', browserConnected: false });

test('supervisor config, command and environment prevent accidental secret/bridge exposure', () => {
  const config = configured({ tunnelEnabled: true });
  const command = commandFor(config, 'tunnel');
  assert.equal(command.args.includes('--token'), false);
  assert.equal(command.args.includes('--token-file'), true);
  assert.equal(command.args.includes('--url'), false);
  assert.equal(command.args.includes('--http-host-header'), false);
  assert.equal(command.args.includes('127.0.0.1:19760'), true);
  assert.equal(command.args.some((part: string) => part.includes('19758')), false);
  assert.equal(command.args.includes(join(config.stateDir, 'cloudflared-supervisor.yml')), true);
  const env = childEnvironment(config, { PATH: 'fixture-path', SystemRoot: 'C:\\Windows', TUNNEL_TOKEN: 'SYNTHETIC_DO_NOT_LOG', TUNNEL_LOGFILE: 'bad.log', TUNNEL_CONFIG: 'bad.yml', NODE_OPTIONS: '--inspect', THREADS_API_ACCESS_TOKEN: 'SYNTHETIC_API', THREADS_ALLOW_WRITES: 'true' });
  assert.equal(env.THREADS_ALLOW_WRITES, 'false');
  assert.equal(env.TUNNEL_TOKEN, undefined); assert.equal(env.TUNNEL_LOGFILE, undefined); assert.equal(env.TUNNEL_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.THREADS_API_ACCESS_TOKEN, undefined);
  for (const overrides of [{ httpPort: 19758 }, { metricsPort: 19758 }, { metricsPort: 19759 }, { tunnelTokenFile: join(project, 'outside.token') }, { tunnelTokenFile: join(config.stateDir, 'nested', 'tunnel.token') }, { token: 'SYNTHETIC_NOT_ALLOWED' }, { healthTimeoutMs: 2000 }])
    assert.throws(() => configured(overrides));
});

test('owned crashes restart with bounded backoff, while alive disconnected/revoked services do not restart', async () => {
  let time = 100000; const children: FakeChild[] = []; const events: object[] = [];
  const service = new Supervisor(configured(), { now: () => time, spawn: (_exe: string, _args: string[], options: object) => { assert.equal((options as any).stdio, 'ignore'); assert.equal((options as any).windowsHide, true); const child = new FakeChild(); children.push(child); return child; }, portAvailable: async () => true, probe: healthy, event: (event: object) => events.push(event) });
  await service.tick(); assert.equal(children.length, 2);
  children[0]!.emit('exit', 17);
  time += 999; await service.tick(); assert.equal(children.length, 2);
  time++; await service.tick(); assert.equal(children.length, 3);
  children[2]!.emit('exit', 17);
  time += 1999; await service.tick(); assert.equal(children.length, 3);
  time++; await service.tick(); assert.equal(children.length, 4);
  children[3]!.emit('exit', 17);
  time += 4000; await service.tick(); assert.equal(children.length, 5);
  service.probe = async (name: string) => name === 'http' ? { state: 'access-disabled', browserConnected: false } : { state: 'host-up', browserConnected: false };
  time += 100000; await service.tick(); await service.tick(); assert.equal(children.length, 5);
  assert.equal(children.reduce((sum, child) => sum + child.killed, 0), 0);
  assert.equal(service.snapshot().services.http.health.state, 'access-disabled');
  assert.deepEqual(events.filter((event: any) => event.event === 'child-exited').map((event: any) => event.backoffMs), [1000, 2000, 4000]);
  await service.stop(); assert.equal(children[1]!.killed, 1); assert.equal(children[4]!.killed, 1);
});

test('unowned listeners are never adopted, stopped, or resurrected after their port becomes free', async () => {
  let free = false; const children: FakeChild[] = [];
  const service = new Supervisor(configured(), { spawn: () => { const child = new FakeChild(); children.push(child); return child; }, portAvailable: async (port: number) => port !== 19758 || free, probe: healthy });
  await service.tick(); assert.equal(children.length, 1); assert.equal(service.snapshot().services.bridge.ownership, 'external-unmanaged');
  free = true; await service.tick(); assert.equal(children.length, 1);
  await service.stop(); assert.equal(children[0]!.killed, 1);
  assert.equal(service.snapshot().services.bridge.ownership, 'external-unmanaged');
});

test('tunnel waits for authenticated HTTP, and stop checked after readiness prevents new children', async () => {
  const children: FakeChild[] = [];
  const service = new Supervisor(configured({ tunnelEnabled: true }), { spawn: () => { const child = new FakeChild(); children.push(child); return child; }, portAvailable: async () => true, probe: async () => ({ state: 'access-disabled' }), canLaunchTunnel: async () => true });
  await service.tick(); assert.equal(children.length, 2); assert.equal(service.snapshot().services.tunnel.process, 'waiting-for-authenticated-http');
  await service.stop();
  let stopping = false;
  const guarded = new Supervisor(configured(), { spawn: () => { assert.fail('No process may be spawned after Stop'); }, shouldStop: async () => stopping, portAvailable: async () => { stopping = true; return true; }, probe: healthy });
  await guarded.tick(); assert.equal(guarded.snapshot().stopping, true);
});

test('real isolated dummy children: crash recovery uses owned handles and discards raw output', async () => {
  let time = Date.now(); const children: ReturnType<typeof spawn>[] = []; const events: object[] = [];
  const service = new Supervisor(configured(), { now: () => time, portAvailable: async () => true, probe: healthy, event: (value: object) => events.push(value), spawn: (_exe: string, _args: string[], options: any) => {
    const first = children.length === 0;
    const code = 'process.stdout.write("SYNTHETIC_PRIVATE_OUTPUT");process.stderr.write("SYNTHETIC_PRIVATE_OUTPUT");' + (first ? 'setTimeout(()=>process.exit(23),80);' : 'setInterval(()=>{},1000);');
    const child = spawn(process.execPath, ['-e', code], options); children.push(child); return child;
  } });
  try {
    await service.tick(); await once(children[0]!, 'exit');
    assert.equal(service.snapshot().services.bridge.process, 'backoff');
    time += 1001; await service.tick(); assert.equal(children.length, 3);
    assert.equal(children.every(child => child.stdout === null && child.stderr === null), true);
    assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE_OUTPUT'), false);
  } finally { await service.stop(); await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit'))); }
});

test('health HTTP deadline bounds a trickling response, independent of socket activity', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
    const timer = setInterval(() => res.write(' '), 20); res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as any).port;
  try {
    assert.equal((await probePort(port)).listening, true);
    const started = Date.now(); const result = await requestStatus(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 180 });
    assert.equal(result.code, 'TIMEOUT'); assert.ok(Date.now() - started < 1200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise())); }
  assert.equal((await probePort(port)).listening, false);
});

test('final status or log failure still stops owned children and releases the singleton lock', async () => {
  for (const failure of ['status', 'events']) {
    const calls: string[] = [];
    await assert.rejects(finalizeRun({
      stopChildren: async () => { calls.push('stop-owned-children'); },
      persistFinal: async () => { calls.push('status'); if (failure === 'status') throw new Error('SYNTHETIC_PERSISTENCE_FAILURE'); },
      flushEvents: async () => { calls.push('events'); if (failure === 'events') throw new Error('SYNTHETIC_PERSISTENCE_FAILURE'); },
      release: async () => { calls.push('release-lock-and-signals'); },
    }), /SYNTHETIC_PERSISTENCE_FAILURE/);
    assert.deepEqual(calls, ['stop-owned-children', 'status', 'events', 'release-lock-and-signals']);
  }
});

test('health reports revoked access and disconnected browser separately; saved logs cannot inject secrets', async () => {
  await mkdir(dataRoot, { recursive: true }); const directory = await mkdtemp(join(dataRoot, 'windows-supervisor-test-'));
  const stateDir = join(directory, 'remote-host'); await mkdir(stateDir);
  let mode = 'disconnected';
  const server = createServer((req, res) => {
    if (mode === 'revoked') { res.writeHead(503).end(); return; }
    if (req.headers.authorization !== `Bearer ${'x'.repeat(43)}`) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ service: 'threads-mcp-readonly', revision: 'remote-health-1', http: 'up', busy: false, bridge: { state: 'extension-disconnected', checkedAt: new Date().toISOString(), errorCode: 'PRIVATE_SHOULD_NOT_ECHO' }, browser: { connected: false }, extra: 'SYNTHETIC_PRIVATE_BODY' }));
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    const port = (server.address() as any).port; const config = configured({ ...sample(directory), httpPort: port });
    await writeFile(join(directory, 'remote-access.token'), 'x'.repeat(43));
    const health = await probeService(config, 'http'); assert.equal(health.state, 'http-up'); assert.equal(health.browserConnected, false); assert.equal(health.bridgeState, 'extension-disconnected');
    assert.equal(JSON.stringify(health).includes('PRIVATE'), false);
    mode = 'revoked'; assert.equal((await probeService(config, 'http')).state, 'access-disabled');
    await rm(join(directory, 'remote-access.token')); assert.equal((await probeService(config, 'http')).state, 'access-disabled');
    await writeFile(join(stateDir, 'status.json'), JSON.stringify({ schemaVersion: 1, runId: 'SYNTHETIC_PRIVATE_SNAPSHOT', updatedAt: new Date().toISOString(), token: 'SYNTHETIC_PRIVATE_SNAPSHOT' }));
    const report = await diagnose(config); assert.equal(report.ports.http.listening, true); assert.equal(report.supervisor.snapshot, null); assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE'), false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    assert.ok(directory.startsWith(join(dataRoot, 'windows-supervisor-test-'))); await rm(directory, { recursive: true, force: true });
  }
});

test('Windows scripts parse; isolated init and protect-secrets never install a task or start services', { skip: process.platform !== 'win32' }, async () => {
  const ps = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const management = join(project, 'scripts', 'windows', 'RemoteHost.ps1'); const acl = join(project, 'scripts', 'windows', 'Assert-PrivatePaths.ps1');
  for (const path of [management, acl]) {
    const script = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){exit 1}`;
    assert.equal(spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 }).status, 0);
  }
  await mkdir(dataRoot, { recursive: true }); const directory = await mkdtemp(join(dataRoot, 'windows-supervisor-test-'));
  const configPath = join(directory, 'remote-host', 'config.json');
  try {
    const init = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', management, '-Action', 'init', '-Config', configPath, '-Hostname', 'threads.example.com', '-NodePath', process.execPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(init.status, 0, init.stderr); const config = await loadConfig(configPath); assert.equal(config.tunnelEnabled, false); assert.equal(config.healthTimeoutMs, 5000);
    await writeFile(join(directory, 'remote-access.token'), 'SYNTHETIC_TEST_FILE_NOT_A_CREDENTIAL');
    await writeFile(config.tunnelTokenFile, 'SYNTHETIC_TEST_FILE_NOT_A_CREDENTIAL');
    const protect = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', management, '-Action', 'protect-secrets', '-Config', configPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(protect.status, 0, protect.stderr); assert.equal((protect.stdout + protect.stderr).includes('SYNTHETIC_TEST_FILE'), false);
    const outside = join(directory, 'outside'); await mkdir(outside); const outsideFile = join(outside, 'tunnel.token'); await writeFile(outsideFile, 'SYNTHETIC_TEST_FILE_NOT_A_CREDENTIAL');
    const nested = join(config.stateDir, 'nested');
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const junction = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path ${quote(nested)} -Target ${quote(outside)} -ErrorAction Stop | Out-Null`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(junction.status, 0, junction.stderr);
    const readAcl = () => {
      const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `[IO.File]::GetAccessControl(${quote(outsideFile)}).Sddl`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.trim().length > 0, 'ACL inspection must return nonempty SDDL');
      return result.stdout;
    };
    const before = readAcl();
    const rejected = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', acl, '-StateDir', config.stateDir, '-ConfigPath', configPath, '-TokenFile', join(nested, 'tunnel.token'), '-ProtectSecrets'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(rejected.status, 1); assert.equal(readAcl(), before); // No ACL mutation outside the private state directory.
    const source = await readFile(management, 'utf8');
    assert.match(source, /-LogonType Interactive -RunLevel Limited/); assert.match(source, /-WindowStyle Hidden/);
    assert.doesNotMatch(source, /Stop-Process|taskkill|Stop-ScheduledTask|\-Password\b/);
  } finally { assert.ok(directory.startsWith(join(dataRoot, 'windows-supervisor-test-'))); await rm(directory, { recursive: true, force: true }); }
});
