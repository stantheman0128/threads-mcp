import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const dataDir = resolve(process.env.THREADS_DATA_DIR || '.threads-data');
await mkdir(resolve(dataDir, 'profile'), { recursive: true });
const context = await chromium.launchPersistentContext(resolve(dataDir, 'profile'), {
  channel: process.env.THREADS_BROWSER_CHANNEL || 'chrome',
  headless: false, viewport: { width: 1180, height: 850 },
  locale: 'en-US',
});
let closed = false;
context.on('close', () => { closed = true; });
const page = context.pages()[0] || await context.newPage();
await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('LOGIN_WINDOW_READY: Sign in manually in the dedicated Threads window. No credentials are read or printed.');
const deadline = Date.now() + 20 * 60 * 1000;
while (!closed && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000));
  if (closed) break;
  const cookies = await context.cookies('https://www.threads.com/');
  const signedIn = cookies.some(c => c.name === 'sessionid' && c.value.length > 0);
  if (signedIn && /https:\/\/(www\.)?threads\.com\//.test(page.url()) && !/\/login|\/challenge/.test(page.url())) {
    await page.waitForTimeout(2500);
    console.log('LOGIN_SESSION_SAVED: Dedicated local browser profile is ready. Account identity will be verified by MCP.');
    await context.close();
    process.exit(0);
  }
}
if (!closed) await context.close();
console.log('LOGIN_NOT_CONFIRMED: Window closed or timed out before a Threads session was observed.');
process.exitCode = 2;
