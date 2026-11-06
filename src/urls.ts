import { ThreadsError } from './types.js';

export function handle(value: string): string {
  const clean = value.trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9._]{1,64}$/.test(clean)) throw new ThreadsError('INVALID_INPUT', 'Use a Threads username, without spaces or a URL.');
  return clean.toLowerCase();
}
export function threadsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ThreadsError('INVALID_INPUT', 'A full Threads HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || !['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ThreadsError('INVALID_INPUT', 'Only HTTPS threads.com / threads.net URLs are accepted.');
  }
  url.hostname = 'www.threads.com';
  url.hash = '';
  return url.href;
}
export function postTarget(value: string): { url: string; code: string } {
  const url = threadsUrl(value);
  const match = new URL(url).pathname.match(/^\/(?:@[\w.]+\/)?post\/([\w-]+)\/?$/);
  if (!match) throw new ThreadsError('INVALID_INPUT', 'Use a canonical Threads post URL: https://www.threads.com/@user/post/CODE');
  return { url, code: match[1]! };
}
export function profileUrl(username: string): string { return `https://www.threads.com/@${handle(username)}`; }
export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.split('_')[0] === b.split('_')[0];
}
