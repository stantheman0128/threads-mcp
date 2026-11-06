import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ThreadsError, type Post, type Completeness } from './types.js';
import {postTarget} from './urls.js';

export interface DraftMedia { type: 'image' | 'video'; url?: string; path?: string; altText?: string; }
export interface DraftInput { text?: string; media?: DraftMedia[]; replyTo?: string; replyUrl?:string; quoteUrl?: string; quotePostId?: string; }
export interface Draft extends DraftInput { id: string; accountId: string; createdAt: string; updatedAt: string; }
export type PublishOutcome = { status: 'confirmed'; postId: string; postUrl?: string; evidence: string[] } |
  { status: 'uncertain' | 'failed'; evidence: string[] };
export interface PublishContext { accountId: string; jobId: string; partIndex: number; idempotencyKey: string; replyTo?: string; previousPostUrl?:string; }
export type Publisher = (draft: Draft, context: PublishContext) => Promise<PublishOutcome>;
export interface WorkflowPart { draft: Draft; status: 'pending' | 'publishing' | 'confirmed' | 'uncertain' | 'failed'; outcome?: PublishOutcome; }
export interface WorkflowJob {
  id: string; accountId: string; at: string; originalAt: string; createdAt: string; updatedAt: string;
  status: 'staged' | 'authorized' | 'running' | 'confirmed' | 'uncertain' | 'failed' | 'cancelled';
  parts: WorkflowPart[]; dedupeKey?: string; authorizedAt?: string; cancelRequested: boolean;
  ownerPid?: number; ownerToken?: string;
}
export interface CollectionCheckpoint { cursor: string | null; updatedAt: string; observedItems: number; }

function invalid(message: string): never { throw new ThreadsError('INVALID_WORKFLOW', message); }
function bounded(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) invalid(`Expected an integer from 1 to ${max}.`);
  return n;
}
export function explicitIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid('Schedule time must be an ISO datetime with Z or an explicit timezone offset.');
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days) invalid('Schedule date is invalid.');
  return new Date(value).toISOString();
}
function publicUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { invalid('Media and quote URLs must be valid HTTP(S) URLs.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('URLs must use HTTP(S) without embedded credentials.');
}
export function validateDraft(input: DraftInput): DraftInput {
  if (typeof input.text !== 'undefined' && (typeof input.text !== 'string' || [...input.text].length > 500)) invalid('Draft text must contain at most 500 Unicode characters.');
  if (input.media && (!Array.isArray(input.media) || input.media.length > 20)) invalid('Drafts support at most 20 media items.');
  if (!input.text?.trim() && !input.media?.length) invalid('A draft needs text or media.');
  for (const media of input.media ?? []) {
    if (!['image', 'video'].includes(media.type) || Boolean(media.url) === Boolean(media.path)) invalid('Each media item needs a type and exactly one URL or absolute local path.');
    if (media.url) publicUrl(media.url);
    if (media.path && (!(isAbsolute(media.path) || win32.isAbsolute(media.path)) || media.path.includes('\0'))) invalid('Media paths must be absolute.');
    if (media.altText !== undefined && (typeof media.altText !== 'string' || media.altText.length > 2000)) invalid('Media alt text must be at most 2000 characters.');
  }
  if (input.replyTo !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(input.replyTo)) invalid('Reply target must be a post identifier.');
  if(input.replyUrl!==undefined){try{postTarget(input.replyUrl);}catch{invalid('Browser reply target must be an exact Threads HTTPS post URL.');}}
  if(input.replyTo&&input.replyUrl)invalid('Choose one reply target representation.');
  if (input.quoteUrl) publicUrl(input.quoteUrl);
  if (input.quotePostId !== undefined && !/^\d{1,100}$/.test(input.quotePostId)) invalid('Official API quote target must be a numeric post ID.');
  if (input.quoteUrl && input.quotePostId) invalid('Choose one quote target representation.');
  if ((input.replyTo||input.replyUrl) && (input.quoteUrl || input.quotePostId)) invalid('A draft cannot be both a reply and a quote.');
  return structuredClone(input);
}

/** Durable local scheduling. Calling runDue is the only execution trigger; opening the store never publishes. */
export class WorkflowStore {
  private readonly db: DatabaseSync;
  private readonly ownerToken = randomUUID();
  private running = false;
  readonly accountId: string;
  constructor(options: { dataDir: string; accountId: string }) {
    if (!/^[a-zA-Z0-9_.@-]{1,200}$/.test(options.accountId)) invalid('A stable, non-secret account identifier is required.');
    this.accountId = options.accountId.toLowerCase();
    mkdirSync(options.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(options.dataDir, 'workflows.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_drafts (account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS workflow_jobs (account TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, dedupe_key TEXT, payload TEXT NOT NULL, PRIMARY KEY(account,id), UNIQUE(account,dedupe_key));
      CREATE TABLE IF NOT EXISTS workflow_checkpoints (account TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,source));`);
    this.recoverAbandoned();
  }
  close(): void {
    if (this.running) throw new ThreadsError('WORKFLOW_RUNNING', 'Wait for runDue to finish before closing its store.');
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private putJob(job: WorkflowJob): WorkflowJob {
    job.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE workflow_jobs SET status=?,payload=? WHERE account=? AND id=?').run(job.status, JSON.stringify(job), this.accountId, job.id);
    return job;
  }
  saveDraft(input: DraftInput, id?: string): Draft {
    const clean = validateDraft(input), now = new Date().toISOString();
    const old = id ? this.getDraft(id) : undefined;
    if (id && !old) throw new ThreadsError('DRAFT_NOT_FOUND', 'Draft does not exist for this account.');
    const draft: Draft = { ...clean, id: old?.id ?? randomUUID(), accountId: this.accountId, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.db.prepare('INSERT OR REPLACE INTO workflow_drafts(account,id,payload) VALUES(?,?,?)').run(this.accountId, draft.id, JSON.stringify(draft));
    return draft;
  }
  getDraft(id: string): Draft | undefined {
    const row = this.db.prepare('SELECT payload FROM workflow_drafts WHERE account=? AND id=?').get(this.accountId, id);
    return row ? JSON.parse(String(row.payload)) as Draft : undefined;
  }
  listDrafts(): Draft[] {
    return this.db.prepare('SELECT payload FROM workflow_drafts WHERE account=? ORDER BY rowid DESC LIMIT 1000').all(this.accountId).map(row => JSON.parse(String(row.payload)) as Draft);
  }
  deleteDraft(id: string): boolean { return this.db.prepare('DELETE FROM workflow_drafts WHERE account=? AND id=?').run(this.accountId, id).changes > 0; }
  stageSchedule(input: { draftIds: string[]; at: string; dedupeKey?: string }): WorkflowJob {
    const at = explicitIso(input.at);
    if (!input.draftIds.length || input.draftIds.length > 20) invalid('A schedule must contain 1 to 20 drafts.');
    if (input.dedupeKey !== undefined && !/^[a-zA-Z0-9_.:-]{1,200}$/.test(input.dedupeKey)) invalid('Dedupe key must contain 1 to 200 identifier characters.');
    return this.transaction(() => {
      const parts = input.draftIds.map((id, index): WorkflowPart => {
        const draft = this.getDraft(id);
        if (!draft) throw new ThreadsError('DRAFT_NOT_FOUND', 'A scheduled draft does not exist for this account.');
        if (index > 0 && (draft.replyTo || draft.replyUrl || draft.quoteUrl || draft.quotePostId)) invalid('Only the first chain part can have an explicit reply or quote target.');
        return { draft, status: 'pending' };
      });
      if (input.dedupeKey) {
        const row = this.db.prepare('SELECT payload FROM workflow_jobs WHERE account=? AND dedupe_key=?').get(this.accountId, input.dedupeKey);
        if (row) {
          const existing = JSON.parse(String(row.payload)) as WorkflowJob;
          if (existing.at !== at || JSON.stringify(existing.parts.map(p => p.draft)) !== JSON.stringify(parts.map(p => p.draft))) throw new ThreadsError('DEDUPE_CONFLICT', 'This dedupe key already identifies a different prepared schedule.');
          return existing;
        }
      }
      const now = new Date().toISOString();
      const job: WorkflowJob = { id: randomUUID(), accountId: this.accountId, at, originalAt: input.at, createdAt: now, updatedAt: now,
        status: 'staged', parts, dedupeKey: input.dedupeKey, cancelRequested: false };
      this.db.prepare('INSERT INTO workflow_jobs(account,id,status,at,dedupe_key,payload) VALUES(?,?,?,?,?,?)').run(this.accountId, job.id, job.status, at, input.dedupeKey ?? null, JSON.stringify(job));
      return job;
    });
  }
  getSchedule(id: string): WorkflowJob {
    const row = this.db.prepare('SELECT payload FROM workflow_jobs WHERE account=? AND id=?').get(this.accountId, id);
    if (!row) throw new ThreadsError('SCHEDULE_NOT_FOUND', 'Schedule does not exist for this account.');
    return JSON.parse(String(row.payload)) as WorkflowJob;
  }
  listSchedules(): WorkflowJob[] {
    return this.db.prepare('SELECT payload FROM workflow_jobs WHERE account=? ORDER BY at,id LIMIT 1000').all(this.accountId).map(row => JSON.parse(String(row.payload)) as WorkflowJob);
  }
  authorizeSchedule(id: string): WorkflowJob {
    return this.transaction(() => {
      const job = this.getSchedule(id);
      if (job.status !== 'staged') throw new ThreadsError('SCHEDULE_STATE', 'Only a staged schedule can be explicitly authorized.');
      job.status = 'authorized'; job.authorizedAt = new Date().toISOString();
      return this.putJob(job);
    });
  }
  cancelSchedule(id: string): WorkflowJob {
    return this.transaction(() => {
      const job = this.getSchedule(id);
      if (['staged', 'authorized'].includes(job.status)) job.status = 'cancelled';
      if (job.status === 'running' || job.status === 'uncertain') job.cancelRequested = true;
      return this.putJob(job);
    });
  }
  /** Only dead-process claims are recovered. A live concurrent runner keeps ownership. */
  recoverAbandoned(): number {
    return this.transaction(() => {
      let recovered = 0;
      const rows = this.db.prepare("SELECT payload FROM workflow_jobs WHERE account=? AND status='running'").all(this.accountId);
      for (const row of rows) {
        const job = JSON.parse(String(row.payload)) as WorkflowJob;
        let alive = true;
        if (!job.ownerPid) alive = false;
        else try { process.kill(job.ownerPid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) continue;
        const part = job.parts.find(p => p.status === 'publishing');
        if (part) {
          job.status = 'uncertain'; part.status = 'uncertain';
          part.outcome = { status: 'uncertain', evidence: ['Runner process ended before the publication outcome was durably recorded. Reconcile externally before continuing.'] };
        } else {
          // A crash between parts has no unrecorded side effect. Keep confirmed parts and require renewed authorization.
          job.status = job.cancelRequested ? 'cancelled' : job.parts.every(p => p.status === 'confirmed') ? 'confirmed' : 'staged';
          delete job.authorizedAt;
        }
        delete job.ownerPid; delete job.ownerToken;
        this.putJob(job); recovered++;
      }
      return recovered;
    });
  }
  /** External evidence can settle an uncertain part. Remaining parts require fresh authorization. */
  reconcileSchedule(id: string, outcome: Exclude<PublishOutcome, { status: 'uncertain' | 'failed' }> | { status: 'failed'; evidence: string[] }): WorkflowJob {
    return this.transaction(() => {
      const job = this.getSchedule(id);
      if (job.status !== 'uncertain') throw new ThreadsError('SCHEDULE_STATE', 'Only an uncertain schedule can be reconciled.');
      if (!outcome.evidence.length || outcome.evidence.some(item => typeof item !== 'string' || !item.trim()) || (outcome.status === 'confirmed' && !outcome.postId?.trim())) invalid('Reconciliation requires external evidence and a post ID when confirmed.');
      const part = job.parts.find(p => p.status === 'uncertain' || p.status === 'publishing');
      if (!part) throw new ThreadsError('SCHEDULE_STATE', 'No uncertain part can be reconciled.');
      part.status = outcome.status; part.outcome = structuredClone(outcome);
      job.status = outcome.status === 'failed' ? 'failed' : job.cancelRequested ? 'cancelled' : job.parts.some(p => p.status === 'pending') ? 'staged' : 'confirmed';
      delete job.ownerPid; delete job.ownerToken; delete job.authorizedAt;
      return this.putJob(job);
    });
  }
  async runDue(publisher: Publisher, options: { writesEnabled: boolean; limit?: number; now?: string }): Promise<WorkflowJob[]> {
    if (!options.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Schedule execution requires the explicit enabled write setting.');
    if (this.running) throw new ThreadsError('WORKFLOW_RUNNING', 'This runner is already executing.');
    const limit = bounded(options.limit, 10, 100), now = options.now ? explicitIso(options.now) : new Date().toISOString();
    this.running = true;
    const results: WorkflowJob[] = [];
    try {
      for (let count = 0; count < limit; count++) {
        const claimed = this.transaction(() => {
          const row = this.db.prepare("SELECT payload FROM workflow_jobs WHERE account=? AND status='authorized' AND at<=? ORDER BY at,id LIMIT 1").get(this.accountId, now);
          if (!row) return undefined;
          const job = JSON.parse(String(row.payload)) as WorkflowJob;
          job.status = 'running'; job.ownerPid = process.pid; job.ownerToken = this.ownerToken;
          return this.putJob(job);
        });
        if (!claimed) break;
        for (let index = 0; index < claimed.parts.length; index++) {
          const job = this.transaction(() => {
            const current = this.getSchedule(claimed.id), part = current.parts[index];
            if (part.status === 'confirmed') return current;
            if (current.cancelRequested) { current.status = 'cancelled'; return this.putJob(current); }
            if (part.status === 'pending') { part.status = 'publishing'; this.putJob(current); }
            return current;
          }), part = job.parts[index];
          if (part.status === 'confirmed') continue;
          if (job.status === 'cancelled' || part.status !== 'publishing') break;
          const previous = index ? job.parts[index - 1].outcome : undefined;
          const replyTo = previous?.status === 'confirmed' ? previous.postId : part.draft.replyTo;
          let outcome: PublishOutcome;
          try {
            outcome = await publisher(structuredClone(part.draft), { accountId: this.accountId, jobId: job.id, partIndex: index,
              idempotencyKey: createHash('sha256').update(`${this.accountId}:${job.id}:${index}`).digest('hex'), ...(replyTo ? { replyTo } : {}),...(previous?.status==='confirmed'&&previous.postUrl?{previousPostUrl:previous.postUrl}:{}) });
            if (!outcome || !['confirmed', 'uncertain', 'failed'].includes(outcome.status) || !Array.isArray(outcome.evidence) || !outcome.evidence.length || outcome.evidence.some(item => typeof item !== 'string' || !item.trim()) || (outcome.status === 'confirmed' && !outcome.postId?.trim())) {
              outcome = { status: 'uncertain', evidence: ['Publisher did not return sufficient structured outcome evidence.'] };
            } else {
              // Persist only contract fields, never arbitrary adapter response metadata.
              outcome = outcome.status === 'confirmed' ? { status: 'confirmed', postId: outcome.postId, ...(outcome.postUrl ? { postUrl: outcome.postUrl } : {}), evidence: [...outcome.evidence] } :
                { status: outcome.status, evidence: [...outcome.evidence] };
            }
          } catch(error) {
            const known=error as {code?:string;outcome?:string;evidence?:unknown};
            const evidence=known.outcome==='unknown'&&['BROWSER_PUBLICATION_UNCERTAIN','BROWSER_PUBLICATION_MISMATCH'].includes(known.code??'')&&Array.isArray(known.evidence)&&known.evidence.every(item=>typeof item==='string'&&item.length<=2000)?known.evidence as string[]:[];
            outcome = { status: 'uncertain', evidence: [...evidence,'Publisher threw after dispatch may have started; no automatic retry is allowed.'] };
          }
          this.transaction(() => {
            const fresh = this.getSchedule(job.id);
            fresh.parts[index].status = outcome.status; fresh.parts[index].outcome = structuredClone(outcome);
            fresh.status = outcome.status === 'confirmed' ? index === fresh.parts.length - 1 ? 'confirmed' : 'running' : outcome.status;
            this.putJob(fresh);
          });
          if (outcome.status !== 'confirmed') break;
        }
        results.push(this.getSchedule(claimed.id));
      }
      return results;
    } finally { this.running = false; }
  }
  getCheckpoint(source: string): CollectionCheckpoint | undefined {
    const row = this.db.prepare('SELECT payload FROM workflow_checkpoints WHERE account=? AND source=?').get(this.accountId, source);
    return row ? JSON.parse(String(row.payload)) as CollectionCheckpoint : undefined;
  }
  setCheckpoint(source: string, checkpoint: CollectionCheckpoint): void {
    if (!source || source.length > 500) invalid('Collection source must contain 1 to 500 characters.');
    this.db.prepare('INSERT OR REPLACE INTO workflow_checkpoints(account,source,payload) VALUES(?,?,?)').run(this.accountId, source, JSON.stringify(checkpoint));
  }
}

export interface CollectionPage { items: Post[]; nextCursor: string | null; completeness: Completeness; warnings?: string[]; }
export interface IncrementalResult { items: Post[]; checkpoint: CollectionCheckpoint; completeness: Completeness; warnings: string[]; pages: number; }
/** Commits a whole page before advancing its cursor. Page providers must honor the supplied item limit. */
export async function collectIncremental(options: {
  fetchPage: (cursor: string | null, limit: number) => Promise<CollectionPage>;
  checkpoint?: CollectionCheckpoint; maxPages?: number; maxItems?: number;
  onPage?: (items: Post[], checkpoint: CollectionCheckpoint) => Promise<void>;
}): Promise<IncrementalResult> {
  const maxPages = bounded(options.maxPages, 3, 100), maxItems = bounded(options.maxItems, 100, 5000);
  let checkpoint: CollectionCheckpoint = options.checkpoint ?? { cursor: null, updatedAt: new Date().toISOString(), observedItems: 0 };
  const items: Post[] = [], seen = new Set<string>(), cursors = new Set<string | null>(), warnings: string[] = [];
  let pages = 0, completeness: Completeness = 'partial';
  while (pages < maxPages && items.length < maxItems) {
    if (cursors.has(checkpoint.cursor)) { warnings.push('Pagination cursor repeated; stopped without assuming complete history.'); break; }
    cursors.add(checkpoint.cursor);
    const remaining = maxItems - items.length;
    const page = await options.fetchPage(checkpoint.cursor, remaining);
    if (page.items.length > remaining) throw new ThreadsError('COLLECTION_LIMIT', 'Page provider exceeded the requested bound; cursor was not advanced.');
    const unique = page.items.filter(post => { if (seen.has(post.id)) return false; seen.add(post.id); return true; });
    const next: CollectionCheckpoint = { cursor: page.nextCursor, updatedAt: new Date().toISOString(), observedItems: checkpoint.observedItems + unique.length };
    await options.onPage?.(unique, next);
    checkpoint = next; items.push(...unique); pages++; warnings.push(...page.warnings ?? []);
    if (!page.nextCursor) { completeness = page.completeness; break; }
  }
  if (checkpoint.cursor && (pages >= maxPages || items.length >= maxItems)) warnings.push('Collection reached its configured bound; resume from the saved cursor.');
  return { items, checkpoint, completeness, warnings: [...new Set(warnings)], pages };
}
export async function collectBatch<T>(targets: string[], collect: (target: string) => Promise<T>): Promise<Array<{ target: string; status: 'ok'; result: T } | { target: string; status: 'failed'; error: string }>> {
  if (!targets.length || targets.length > 20) invalid('Batch collection supports 1 to 20 targets.');
  const results: Array<{ target: string; status: 'ok'; result: T } | { target: string; status: 'failed'; error: string }> = [];
  for (const target of [...new Set(targets)]) {
    try { results.push({ target, status: 'ok', result: await collect(target) }); }
    catch (error) { results.push({ target, status: 'failed', error: error instanceof ThreadsError ? error.code : 'COLLECTION_FAILED' }); }
  }
  return results;
}
export function exportPosts(posts: Post[], format: 'json' | 'csv'): string {
  if (format === 'json') return JSON.stringify({ completeness: 'observed-window-only', exportedAt: new Date().toISOString(), items: posts }, null, 2);
  if (format !== 'csv') invalid('Export format must be json or csv.');
  const columns = ['id', 'url', 'username', 'text', 'createdAt', 'likes', 'replies', 'reposts', 'quotes', 'views', 'isReply', 'parentId', 'rootId', 'observedAt', 'source', 'media'];
  const cell = (value: unknown): string => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(s) || /^[\t\r\n]/u.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(','), ...posts.map(post => [post.id, post.url, post.author.username, post.text, post.createdAt,
    post.likes, post.replies, post.reposts, post.quotes, post.views, post.isReply, post.parentId, post.rootId, post.observedAt, post.source, JSON.stringify(post.media)].map(cell).join(','))].join('\r\n') + '\r\n';
}
