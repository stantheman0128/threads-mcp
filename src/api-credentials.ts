import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThreadsError } from './types.js';

export interface StoredOfficialCredentials {
  accessToken: string;
  userId: string;
  username: string;
  savedAt: string;
}
export type OfficialCredentialsInput = Pick<StoredOfficialCredentials, 'accessToken' | 'userId' | 'username'>;
/** Explicit dependency injection for isolated tests; production defaults exclusively to DPAPI. */
export interface CredentialProtector {
  protect(plaintext: Buffer): Buffer;
  unprotect(ciphertext: Buffer): Buffer;
}
const FILE_NAME = 'api-credentials.json';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const entropy = 'stan.threads-mcp.official-api.credentials.v1';

// Both scripts are static. Payloads travel through stdin, never command arguments,
// environment variables or plaintext temporary files. Do not expose child output on error.
const prefix = `$ErrorActionPreference = 'Stop'; try { Add-Type -AssemblyName System.Security; ` +
  `$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
  `$entropy = [Text.Encoding]::UTF8.GetBytes('${entropy}'); `;
const protectScript = prefix +
  `$result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[Console]::Out.Write([Convert]::ToBase64String($result)); exit 0 } catch { exit 1 }`;
const unprotectScript = prefix +
  `$result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[Console]::Out.Write([Convert]::ToBase64String($result)); exit 0 } catch { exit 1 }`;

function failure(code: string, message: string): never { throw new ThreadsError(code, message); }
function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    failure('API_CREDENTIALS_INVALID', 'The encrypted credential store is invalid.');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > maxBytes || decoded.toString('base64') !== value)
    failure('API_CREDENTIALS_INVALID', 'The encrypted credential store is invalid.');
  return decoded;
}
function runDpapi(script: string, value: Buffer, maxOutputBytes: number): Buffer {
  if (process.platform !== 'win32') failure('API_CREDENTIALS_UNAVAILABLE', 'Encrypted credential storage requires Windows DPAPI for the current user.');
  try {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: value.toString('base64'), encoding: 'utf8', windowsHide: true,
      timeout: 15_000, maxBuffer: MAX_FILE_BYTES, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.error || result.signal) throw new Error();
    return decodeBase64(result.stdout.trim(), maxOutputBytes);
  } catch {
    failure('API_CREDENTIALS_PROTECTION_FAILED', 'Windows could not protect or unlock credentials for the current user.');
  }
}
const windowsProtector: CredentialProtector = {
  protect: bytes => runDpapi(protectScript, bytes, MAX_FILE_BYTES / 2),
  unprotect: bytes => runDpapi(unprotectScript, bytes, MAX_PAYLOAD_BYTES),
};

function validateInput(value: unknown): value is OfficialCredentialsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as OfficialCredentialsInput;
  return typeof input.accessToken === 'string' && input.accessToken.length >= 1 && input.accessToken.length <= 8192 &&
    !/[\s\x00-\x1f\x7f]/.test(input.accessToken) && typeof input.userId === 'string' && /^[0-9]{1,30}$/.test(input.userId) &&
    typeof input.username === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(input.username);
}

/** Replaces only this application's encrypted credential file, atomically. */
export function saveOfficialCredentials(dataDir: string, input: OfficialCredentialsInput, protector: CredentialProtector = windowsProtector): void {
  if (!validateInput(input)) failure('API_CREDENTIALS_INVALID', 'Provide a valid access token, numeric account ID and username.');
  const payload: StoredOfficialCredentials = { accessToken: input.accessToken, userId: input.userId, username: input.username, savedAt: new Date().toISOString() };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length > MAX_PAYLOAD_BYTES) { plaintext.fill(0); failure('API_CREDENTIALS_INVALID', 'The credential payload exceeds its storage limit.'); }
  let ciphertext: Buffer;
  try {
    ciphertext = protector.protect(plaintext);
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > MAX_FILE_BYTES / 2) throw new Error();
  } catch (error) {
    if (error instanceof ThreadsError && error.code === 'API_CREDENTIALS_UNAVAILABLE') failure('API_CREDENTIALS_UNAVAILABLE', 'Encrypted credential storage requires Windows DPAPI for the current user.');
    failure('API_CREDENTIALS_PROTECTION_FAILED', 'Windows could not protect credentials for the current user.');
  } finally { plaintext.fill(0); }
  const envelope = JSON.stringify({ version: 1, protection: 'windows-dpapi', scope: 'currentuser', ciphertext: ciphertext.toString('base64') });
  const target = join(dataDir, FILE_NAME);
  const temporary = join(dataDir, `.api-credentials-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let created = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, envelope, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target);
    created = false;
  } catch {
    failure('API_CREDENTIALS_WRITE_FAILED', 'The encrypted credential store could not be saved.');
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* no secret diagnostics */ } }
    if (created) { try { unlinkSync(temporary); } catch { /* ciphertext-only temporary may remain */ } }
  }
}

/** Missing store is undefined; malformed/unavailable/unlock failures are explicit and sanitized. */
export function loadOfficialCredentials(dataDir: string, protector: CredentialProtector = windowsProtector): StoredOfficialCredentials | undefined {
  const target = join(dataDir, FILE_NAME);
  let descriptor: number;
  try { descriptor = openSync(target, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    failure('API_CREDENTIALS_READ_FAILED', 'The encrypted credential store could not be read.');
  }
  let ciphertext: Buffer;
  try {
    if (protector === windowsProtector && process.platform !== 'win32') failure('API_CREDENTIALS_UNAVAILABLE', 'Encrypted credential storage requires Windows DPAPI for the current user.');
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) throw new Error();
    const envelope = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!envelope || envelope.version !== 1 || envelope.protection !== 'windows-dpapi' || envelope.scope !== 'currentuser') throw new Error();
    ciphertext = decodeBase64(envelope.ciphertext, MAX_FILE_BYTES / 2);
  } catch (error) {
    if (error instanceof ThreadsError && error.code === 'API_CREDENTIALS_UNAVAILABLE') failure('API_CREDENTIALS_UNAVAILABLE', 'Encrypted credential storage requires Windows DPAPI for the current user.');
    failure('API_CREDENTIALS_INVALID', 'The encrypted credential store is invalid.');
  } finally { closeSync(descriptor); }
  let plaintext: Buffer | undefined;
  try {
    plaintext = protector.unprotect(ciphertext);
    if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_PAYLOAD_BYTES) throw new Error();
    const value = JSON.parse(plaintext.toString('utf8'));
    if (!validateInput(value)) throw new Error();
    const stored = value as StoredOfficialCredentials;
    if (typeof stored.savedAt !== 'string' || new Date(stored.savedAt).toISOString() !== stored.savedAt) throw new Error();
    return { accessToken: stored.accessToken, userId: stored.userId, username: stored.username, savedAt: stored.savedAt };
  } catch (error) {
    if (error instanceof ThreadsError && error.code === 'API_CREDENTIALS_UNAVAILABLE') failure('API_CREDENTIALS_UNAVAILABLE', 'Encrypted credential storage requires Windows DPAPI for the current user.');
    failure('API_CREDENTIALS_UNLOCK_FAILED', 'The credential store could not be unlocked for this Windows user. Reconnect the official account.');
  } finally { plaintext?.fill(0); }
}
