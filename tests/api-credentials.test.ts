import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOfficialCredentials, saveOfficialCredentials, type CredentialProtector } from '../src/api-credentials.js';

// Every payload in this suite is generated synthetic test data, never an account credential.
const fixture = () => ({ accessToken: `synthetic-${randomUUID()}`, userId: '123456789', username: 'synthetic_fixture' });
function fixtureProtector(): CredentialProtector {
  const key = randomBytes(32);
  return {
    protect(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    unprotect(ciphertext) {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}
function temporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'threads-credentials-test-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('credentials missing store returns undefined without invoking protection', () => temporary(directory => {
  assert.equal(loadOfficialCredentials(directory, { protect() { throw new Error(); }, unprotect() { throw new Error(); } }), undefined);
}));

test('credential store encrypts payload, adds timestamp and atomically replaces own file', () => temporary(directory => {
  const input = fixture();
  const protector = fixtureProtector();
  saveOfficialCredentials(directory, input, protector);
  const raw = readFileSync(join(directory, 'api-credentials.json'), 'utf8');
  assert.equal(raw.includes(input.accessToken), false);
  assert.equal(raw.includes(input.username), false);
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'protection', 'scope', 'version']);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.protection, 'windows-dpapi');
  assert.equal(envelope.scope, 'currentuser');
  const loaded = loadOfficialCredentials(directory, protector)!;
  assert.equal(loaded.accessToken === input.accessToken, true);
  assert.equal(loaded.userId, input.userId);
  assert.equal(loaded.username, input.username);
  assert.equal(new Date(loaded.savedAt).toISOString(), loaded.savedAt);
  const replacement = fixture();
  saveOfficialCredentials(directory, replacement, protector);
  assert.equal(loadOfficialCredentials(directory, protector)!.accessToken === replacement.accessToken, true);
  assert.deepEqual(readdirSync(directory), ['api-credentials.json']);
}));

test('invalid inputs never create a plaintext or encrypted store', () => temporary(directory => {
  for (const input of [
    { ...fixture(), accessToken: '' }, { ...fixture(), accessToken: 'x'.repeat(8193) },
    { ...fixture(), accessToken: 'contains whitespace' }, { ...fixture(), userId: 'not-a-number' },
    { ...fixture(), username: '../unsafe' },
  ]) assert.throws(() => saveOfficialCredentials(directory, input, fixtureProtector()), { code: 'API_CREDENTIALS_INVALID' });
  assert.deepEqual(readdirSync(directory), []);
}));

test('malformed envelopes and other-user decrypt failures have sanitized errors', () => temporary(directory => {
  const file = join(directory, 'api-credentials.json');
  const input = fixture();
  const protector = fixtureProtector();
  for (const contents of ['{', 'null', '{}', JSON.stringify({ version: 2, protection: 'windows-dpapi', scope: 'currentuser', ciphertext: 'YQ==' }),
    JSON.stringify({ version: 1, protection: 'windows-dpapi', scope: 'localmachine', ciphertext: 'YQ==' }), 'x'.repeat(65537)]) {
    writeFileSync(file, contents);
    assert.throws(() => loadOfficialCredentials(directory, protector), { code: 'API_CREDENTIALS_INVALID' });
  }
  saveOfficialCredentials(directory, input, protector);
  assert.throws(() => loadOfficialCredentials(directory, fixtureProtector()), error => {
    assert.equal((error as any).code, 'API_CREDENTIALS_UNLOCK_FAILED');
    assert.equal(String(error).includes(input.accessToken), false);
    return true;
  });
  const leakingProtector: CredentialProtector = {
    protect() { throw new Error(input.accessToken); }, unprotect() { throw new Error(input.accessToken); },
  };
  const original = readFileSync(file, 'utf8');
  assert.throws(() => saveOfficialCredentials(directory, input, leakingProtector), error => {
    assert.equal((error as any).code, 'API_CREDENTIALS_PROTECTION_FAILED');
    assert.equal(String(error).includes(input.accessToken), false);
    return true;
  });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.throws(() => loadOfficialCredentials(directory, leakingProtector), error => {
    assert.equal(String(error).includes(input.accessToken), false);
    return true;
  });
}));

test('Windows DPAPI CurrentUser synthetic roundtrip and ciphertext tamper rejection', { skip: process.platform !== 'win32' }, () => temporary(directory => {
  const input = fixture();
  saveOfficialCredentials(directory, input);
  const loaded = loadOfficialCredentials(directory)!;
  assert.equal(loaded.accessToken === input.accessToken, true);
  assert.equal(loaded.userId, input.userId);
  const file = join(directory, 'api-credentials.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(input.accessToken), false);
  const envelope = JSON.parse(raw);
  const corrupted = Buffer.from(envelope.ciphertext, 'base64');
  corrupted[corrupted.length - 1] ^= 1;
  envelope.ciphertext = corrupted.toString('base64');
  writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => loadOfficialCredentials(directory), { code: 'API_CREDENTIALS_UNLOCK_FAILED' });
}));

test('non-Windows defaults explicitly reject storage without fallback', { skip: process.platform === 'win32' }, () => temporary(directory => {
  assert.equal(loadOfficialCredentials(directory), undefined);
  assert.throws(() => saveOfficialCredentials(directory, fixture()), { code: 'API_CREDENTIALS_UNAVAILABLE' });
  assert.deepEqual(readdirSync(directory), []);
  saveOfficialCredentials(directory, fixture(), fixtureProtector());
  assert.throws(() => loadOfficialCredentials(directory), { code: 'API_CREDENTIALS_UNAVAILABLE' });
}));
