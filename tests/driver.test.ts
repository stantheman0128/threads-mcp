import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import type { BridgeServer } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { DedicatedDriver, ExtensionDriver } from '../src/driver.js';

const config: Config = { dataDir: '.threads-data', profileDir: '.threads-data/test-profile', channel: 'chrome',
  headless: true, writesEnabled: false, timeoutMs: 100, minActionIntervalMs: 0 };

test('extension serializes commands, rejects invalid URLs, and never retries failed interaction', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const bridge = {
    status: () => ({ connected: true }), close: async () => {},
    async command(command: Record<string, unknown>) {
      calls.push(String(command.type));
      if (command.type === 'snapshot') { await barrier; return { snapshotId: 'one' }; }
      if (command.type === 'interact') throw new Error('Unknown dispatch outcome');
      return { ok: true };
    },
  } as unknown as BridgeServer;
  const driver = new ExtensionDriver(bridge);
  const snapshot = driver.command({ type: 'snapshot' });
  const interaction = driver.command({ type: 'interact', snapshotId: 'one', ref: '1', verb: 'click' });
  const interactionRejected = assert.rejects(interaction, /Unknown dispatch/);
  const read = driver.command({ type: 'read' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['snapshot']);
  release();
  await Promise.all([snapshot, interactionRejected, read]);
  assert.deepEqual(calls, ['snapshot', 'interact', 'read']);
  for (const url of ['https://threads.com.evil.test/', 'https://evil.threads.com/', 'http://threads.com/', 'https://user@threads.com/']) {
    await assert.rejects(driver.command({ type: 'navigate', url }), /Only HTTPS/);
  }
  await driver.close();
  await assert.rejects(driver.command({ type: 'read' }), /closed/);
  assert.equal(calls.length, 3);
});

test('dedicated driver is lazy, installs runtime once, preserves same page, and respects user close', async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const context = new EventEmitter();
  const page = new EventEmitter();
  let currentUrl = 'about:blank';
  let launched = 0, injections = 0, evaluated = 0, contextClosed = false;
  Object.assign(page, {
    isClosed: () => contextClosed, url: () => currentUrl, title: async () => 'fixture',
    goto: async (url: string) => { currentUrl = url; },
    evaluate: async (_fn: unknown, command: Record<string, unknown>) => { evaluated++; return { result: command.type }; },
  });
  Object.assign(context, {
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    addInitScript: async () => { injections++; }, pages: () => [page],
    close: async () => { contextClosed = true; context.emit('close'); },
  });
  chromium.launchPersistentContext = async () => { launched++; return context as unknown as BrowserContext; };
  try {
    const driver = new DedicatedDriver(config);
    assert.equal(launched, 0);
    await assert.rejects(driver.command({ type: 'navigate', url: 'file:///private' }), /Only HTTPS/);
    assert.equal(launched, 0);
    assert.equal(await driver.command({ type: 'snapshot' }), 'snapshot');
    assert.equal(await driver.command({ type: 'interact', snapshotId: 's', ref: '1', verb: 'click' }), 'interact');
    await driver.command({ type: 'read' });
    assert.equal(launched, 1);
    assert.equal(injections, 1);
    assert.equal(evaluated, 3);
    page.emit('close');
    await assert.rejects(driver.command({ type: 'read' }), /dedicated browser was closed/);
    assert.equal(launched, 1);
    await driver.close();
    assert.equal(contextClosed, true);
  } finally { chromium.launchPersistentContext = originalLaunch; }
});
