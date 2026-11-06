import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SearchIndex } from '../src/search.js';
import type { Post } from '../src/types.js';

// Synthetic local data only. The sole remote operation is downloading public model weights.
const dataDir = resolve(process.env.THREADS_SEMANTIC_SMOKE_DIR ?? '.threads-data/semantic-smoke');
mkdirSync(dataDir, { recursive: true });
const index = new SearchIndex(dataDir, { fallbackOnError: false });
const samples = [
  ['commute', '每天搭捷運上下班，塞車問題少很多，交通費也比較省。'],
  ['coffee', '這間咖啡館有插座和穩定網路，很適合帶筆電遠端工作。'],
  ['burnout', '最近加班到凌晨，睡眠不足，身心疲憊，想請假休息幾天。'],
  ['pet', '小貓第一次去獸醫診所打疫苗，回家後一直躲在紙箱裡。'],
  ['cooking', '今天分享番茄義大利麵做法，加蒜頭和羅勒，十分鐘就能完成。'],
];
const cases = [
  { query: '哪裡能坐著用電腦辦公？', expected: 'coffee' },
  { query: '過勞睡不夠該休息', expected: 'burnout' },
  { query: '公共運輸通勤能省錢嗎', expected: 'commute' },
  { query: 'remote work friendly cafe', expected: 'coffee' },
];
const observedAt = new Date().toISOString();
const posts: Post[] = samples.map(([id, text]) => ({ id: `semantic-smoke-${id}`, text,
  url: `https://www.threads.com/@synthetic/post/${id}`, author: { username: 'synthetic' },
  createdAt: null, observedAt, likes: null, replies: null, reposts: null, quotes: null, views: null,
  isReply: null, parentId: null, rootId: null, media: [], source: 'local-index' }));
const report: Record<string, unknown> = { startedAt: observedAt, corpus: 'five synthetic Traditional Chinese posts',
  model: index.stats().embeddingModel, results: [], status: 'RUNNING' };
const results: unknown[] = [];
report.results = results;
try {
  index.upsert(posts);
  for (const entry of cases) {
    const semantic = await index.search(entry.query, { mode: 'semantic', limit: 3 });
    const lexical = await index.search(entry.query, { mode: 'lexical', limit: 3 });
    const actual = semantic.items[0]?.post.id;
    const pass = actual === `semantic-smoke-${entry.expected}` && semantic.method === 'semantic-multilingual-embeddings';
    results.push({ ...entry, actual, pass, method: semantic.method,
      semantic: semantic.items.map(item => ({ id: item.post.id, score: item.score, lexicalScore: item.lexicalScore })),
      lexical: lexical.items.map(item => ({ id: item.post.id, score: item.score })), warnings: semantic.warnings });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${entry.query}: ${actual} (${semantic.method})`);
  }
  report.status = results.every(result => (result as { pass: boolean }).pass) ? 'PASS' : 'FAIL';
  report.stats = index.stats();
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  report.status = 'BLOCKED';
  report.error = error instanceof Error ? error.message : 'Unknown local embedding error';
  console.error(`BLOCKED: ${report.error}`);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  writeFileSync(join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  index.close();
  console.log(`Report: ${join(dataDir, 'report.json')}`);
}
