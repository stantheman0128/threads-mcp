import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/config.js';
import { OfficialThreadsApi, officialApiOptionsFromEnv, type OfficialReadInput, type OfficialReadOperation } from '../src/official-api.js';

type Status = 'PASS' | 'PARTIAL' | 'BLOCKED';
type ProbeStatus = 'PASS' | 'BLOCKED' | 'SKIPPED';
interface Probe {
  operation: string; status: ProbeStatus; required: boolean; reason: string;
  observedItems?: number; empty?: boolean; publicResultObserved?: boolean;
  errorCode?: string; httpStatus?: number;
}
export interface ApiLiveReport {
  schemaVersion: 1; status: Status; startedAt: string; finishedAt: string;
  source: 'official_threads_api'; mode: 'read_only'; writesPerformed: false;
  requests: number; maxRequests: 11;
  identity?: { fingerprint: string; configuredIdMatched: boolean | null; expectedUsernameMatched: boolean | null };
  checks: Probe[]; limitations: string[];
}
type Reader = Pick<OfficialThreadsApi, 'read' | 'status'>;
const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
const validUsername = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeErrorCodes = new Set(['API_NOT_CONFIGURED', 'API_AUTH_REQUIRED', 'API_PERMISSION_REQUIRED', 'API_RATE_LIMITED', 'API_REQUEST_FAILED', 'API_INVALID_RESPONSE', 'API_TRANSPORT_FAILED', 'INVALID_INPUT']);
const stopCodes = new Set(['API_AUTH_REQUIRED', 'API_RATE_LIMITED', 'API_TRANSPORT_FAILED']);
const optional: OfficialReadOperation[] = ['post', 'replies', 'conversation', 'post_insights', 'user_insights', 'mentions', 'search', 'profile_lookup', 'publishing_limit'];

/** Never calls prepare/execute, follows pagination, or returns raw API content. Injectable for offline verification. */
export async function runApiLiveChecks(api: Reader, options: { expectedAccount?: string } = {}): Promise<ApiLiveReport> {
  const report: ApiLiveReport = {
    schemaVersion: 1, status: 'BLOCKED', startedAt: new Date().toISOString(), finishedAt: '',
    source: 'official_threads_api', mode: 'read_only', writesPerformed: false, requests: 0, maxRequests: 11, checks: [],
    limitations: [
      'Only bounded read-only endpoint access is tested. No publishing, deletion, moderation, upload, token exchange or refresh is attempted.',
      'A successful empty response establishes endpoint access only. It does not establish content availability or exhaustive history.',
      'Granted OAuth scopes and advanced app review status are not introspected. Keyword search may be restricted to own posts; profile lookup tests only the standard public meta profile.',
      'No account profile, post text, media URL, insight value, token, raw response or error message is retained in this report.',
    ],
  };
  const finish = () => { report.finishedAt = new Date().toISOString(); return report; };
  const expected = options.expectedAccount?.trim().replace(/^@/, '').toLowerCase();
  if (options.expectedAccount !== undefined && !validUsername(expected)) {
    report.checks.push({ operation: 'configuration', status: 'BLOCKED', required: true, reason: 'Expected account must be a nonempty Threads username, optionally prefixed with @.' });
    return finish();
  }
  const configuration = api.status();
  if (!configuration.configured) {
    report.checks.push({ operation: 'configuration', status: 'BLOCKED', required: true, reason: 'Official API credential is unavailable. No network request was made.', errorCode: 'API_NOT_CONFIGURED' });
    return finish();
  }
  let stopReason: string | undefined;
  const read = async (operation: OfficialReadOperation, input: OfficialReadInput, required: boolean) => {
    if (stopReason) {
      report.checks.push({ operation, status: 'SKIPPED', required, reason: stopReason });
      return undefined;
    }
    if (report.requests >= report.maxRequests) throw new Error('Internal request budget exceeded');
    report.requests++;
    try { return (await api.read(operation, input)).data; }
    catch (error) {
      const value = error as { code?: unknown; httpStatus?: unknown };
      const errorCode = typeof value?.code === 'string' && safeErrorCodes.has(value.code) ? value.code : 'API_CHECK_FAILED';
      const httpStatus = typeof value?.httpStatus === 'number' && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
      report.checks.push({ operation, status: 'BLOCKED', required, reason: 'The API request did not establish successful access. Error details are deliberately omitted.', errorCode, ...(httpStatus ? { httpStatus } : {}) });
      if (stopCodes.has(errorCode)) stopReason = `Remaining checks skipped after ${errorCode}; no automatic retry was attempted.`;
      return undefined;
    }
  };
  const shapeFailure = (operation: OfficialReadOperation, required: boolean) => report.checks.push({ operation, required, status: 'BLOCKED', reason: 'API response did not match the expected minimal schema.', errorCode: 'API_INVALID_RESPONSE' });
  const listResult = (operation: OfficialReadOperation, value: Record<string, unknown>, required: boolean) => {
    if (!Array.isArray(value.data)) { shapeFailure(operation, required); return false; }
    report.checks.push({ operation, required, status: 'PASS', observedItems: value.data.length, empty: value.data.length === 0,
      reason: value.data.length ? 'Endpoint access and a nonempty bounded response were verified.' : 'Endpoint access was verified with a valid empty page; no content availability claim is made.' });
    return true;
  };
  const profile = await read('own_profile', {}, true);
  if (!profile) return finish();
  if (!validId(profile.id) || !validUsername(profile.username)) { shapeFailure('own_profile', true); return finish(); }
  const profileUsername = profile.username.toLowerCase();
  const configuredId = configuration.userId !== 'me' ? configuration.userId : undefined;
  const configuredIdMatched = configuredId === undefined ? null : configuredId === profile.id;
  const expectedUsernameMatched = expected === undefined ? null : expected === profileUsername;
  report.identity = { fingerprint: createHash('sha256').update(`${profile.id}\0${profileUsername}`).digest('hex').slice(0, 20), configuredIdMatched, expectedUsernameMatched };
  if (configuredIdMatched === false || expectedUsernameMatched === false) {
    report.checks.push({ operation: 'own_profile', required: true, status: 'BLOCKED', reason: 'Authenticated identity does not match the configured numeric ID or expected username. Further reads were aborted.' });
    return finish();
  }
  report.checks.push({ operation: 'own_profile', required: true, status: 'PASS', reason: 'A valid authenticated identity was returned; only a fingerprint and match flags are retained.' });
  const posts = await read('own_posts', { limit: 5 }, true);
  if (!posts || !listResult('own_posts', posts, true)) return finish();
  const ownPost = (posts.data as unknown[]).find(value => isObject(value) && validId(value.id)) as { id: string } | undefined;
  for (const operation of optional) {
    const needsPost = ['post', 'replies', 'conversation', 'post_insights'].includes(operation);
    if (needsPost && !ownPost) {
      report.checks.push({ operation, required: false, status: 'SKIPPED', reason: 'No usable own-post ID was observed in the bounded page; dependent access was not tested.' });
      continue;
    }
    const input: OfficialReadInput = needsPost ? { id: ownPost!.id, ...(['replies', 'conversation'].includes(operation) ? { limit: 1 } : {}), ...(operation === 'post_insights' ? { metric: 'views' } : {}) }
      : operation === 'search' ? { q: 'Threads', search_type: 'RECENT', limit: 1 }
      : operation === 'profile_lookup' ? { username: 'meta' }
      : operation === 'user_insights' ? { metric: 'views' }
      : operation === 'mentions' ? { limit: 1 } : {};
    const data = await read(operation, input, false);
    if (!data) continue;
    if (operation === 'post') {
      if (data.id !== ownPost!.id) { shapeFailure(operation, false); continue; }
      report.checks.push({ operation, required: false, status: 'PASS', reason: 'The selected own-post ID was read successfully; its content was not retained.' });
    } else if (operation === 'profile_lookup') {
      if (typeof data.username !== 'string' || data.username.toLowerCase() !== 'meta') { shapeFailure(operation, false); continue; }
      report.checks.push({ operation, required: false, status: 'PASS', reason: 'The standard-access meta profile lookup succeeded; advanced access to arbitrary profiles remains unverified.' });
    } else if (listResult(operation, data, false) && operation === 'search') {
      report.checks.at(-1)!.publicResultObserved = (data.data as unknown[]).some(value => isObject(value) && validUsername(value.username) && value.username.toLowerCase() !== profileUsername);
    }
  }
  const requiredPassed = report.checks.filter(check => check.required).every(check => check.status === 'PASS');
  const pinnedIdentity = configuredIdMatched === true || expectedUsernameMatched === true;
  report.status = !requiredPassed ? 'BLOCKED' : !pinnedIdentity || report.checks.some(check => check.status !== 'PASS') ? 'PARTIAL' : 'PASS';
  if (!pinnedIdentity) report.limitations.push('Authenticated identity was observed but not pinned to a configured ID or expected username; rerun with an expected account for acceptance.');
  return finish();
}

function saveReport(dataDir: string, report: ApiLiveReport): string {
  const directory = join(dataDir, 'api-live-checks');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Read-only official Threads API verification\nUsage: node --import tsx scripts/api-live-smoke.ts [--expected-account USERNAME]\nEnvironment: THREADS_API_ACCESS_TOKEN, THREADS_API_USER_ID, THREADS_API_EXPECTED_ACCOUNT, THREADS_DATA_DIR\nExit codes: 0 PASS, 2 PARTIAL, 3 BLOCKED. No mutations or OAuth setup are performed.');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--expected-account')) throw new Error('INVALID_ARGUMENTS');
  const expectedAccount = args[1] ?? process.env.THREADS_API_EXPECTED_ACCOUNT;
  const api = new OfficialThreadsApi({ ...officialApiOptionsFromEnv(), writesEnabled: false });
  const report = await runApiLiveChecks(api, { expectedAccount });
  const evidencePath = saveReport(getConfig().dataDir, report);
  console.log(JSON.stringify({ status: report.status, requests: report.requests, writesPerformed: false, checks: report.checks, evidencePath }));
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'PARTIAL' ? 2 : 3;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Do not echo unknown error objects: configuration/filesystem exceptions can include sensitive input.
    console.error(JSON.stringify({ status: 'BLOCKED', error: 'API_CHECK_SETUP_FAILED', writesPerformed: false,
      reason: 'Check nonsecret arguments, numeric user ID configuration and data-directory writability. No raw error details are printed.' }));
    process.exitCode = 3;
  });
}
