import { resolve } from 'node:path';

export interface Config {
  dataDir: string;
  profileDir: string;
  channel: string;
  headless: boolean;
  writesEnabled: boolean;
  timeoutMs: number;
  minActionIntervalMs: number;
}
export function getConfig(): Config {
  const dataDir = resolve(process.env.THREADS_DATA_DIR || '.threads-data');
  return {
    dataDir, profileDir: resolve(dataDir, 'profile'),
    channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome',
    headless: process.env.THREADS_HEADLESS !== 'false',
    writesEnabled: process.env.THREADS_ALLOW_WRITES === 'true',
    timeoutMs: 30_000,
    minActionIntervalMs: 8_000,
  };
}
