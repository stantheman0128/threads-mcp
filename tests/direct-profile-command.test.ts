import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDirectProfileCommand } from '../src/direct-profile-command.js';
import { ExtensionDriver } from '../src/driver.js';
import type { BridgeServer } from '../src/bridge.js';

const valid = { type: 'direct_profile', username: 'fixture.name_1', maxPages: 2, pageSize: 10 };
const invalid = [null, [], {}, { ...valid, type: 'fetch' }, { ...valid, url: 'https://www.threads.com/graphql/query' },
  { ...valid, cursor: 'opaque' }, { ...valid, headers: {} }, { ...valid, username: '@fixture' },
  { ...valid, username: 'a/b' }, { ...valid, username: 'a'.repeat(31) }, { ...valid, username: '' },
  { ...valid, maxPages: 0 }, { ...valid, maxPages: 6 }, { ...valid, maxPages: 1.5 }, { ...valid, maxPages: '2' },
  { ...valid, pageSize: 0 }, { ...valid, pageSize: 21 }, { ...valid, pageSize: Infinity }, { ...valid, pageSize: undefined }];

test('direct profile validates only exact typed profile identity and bounded page counts', () => {
  for (const command of [valid, { ...valid, username: 'a', maxPages: 1, pageSize: 1 }, { ...valid, username: 'a'.repeat(30), maxPages: 5, pageSize: 20 }])
    assert.doesNotThrow(() => validateDirectProfileCommand(command));
  for (const command of invalid) assert.throws(() => validateDirectProfileCommand(command), { code: 'INVALID_COMMAND' });
});

test('extension driver passes direct profile command once and rejects invalid payloads before dispatch', async () => {
  const calls: Record<string, unknown>[] = [];
  const bridge = { status: () => ({}), close: async () => {}, command: async (command: Record<string, unknown>) => {
    calls.push(command); return { posts: [] };
  } } as unknown as BridgeServer;
  const driver = new ExtensionDriver(bridge);
  assert.deepEqual(await driver.command(valid), { posts: [] });
  for (const command of invalid.filter(value => value && !Array.isArray(value)))
    await assert.rejects(driver.command(command as Record<string, unknown>), { code: 'INVALID_COMMAND' });
  assert.deepEqual(calls, [valid]);
  await driver.close();
});
