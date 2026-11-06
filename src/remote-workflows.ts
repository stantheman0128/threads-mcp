import { mkdirSync, lstatSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserDriver } from './driver.js';
import type { PageRead } from './page-runtime.js';
import type { ThreadsService } from './service.js';
import { sameThreadsRoute } from './service.js';
import type { RemoteSocialController } from './remote-social.js';
import type { RemoteMediaController } from './remote-media.js';
import { assertRemoteDraftSafe, assertRemoteViewer, checkedRemoteSocialRequest } from './remote-social-driver.js';
import type { SocialRequest } from './social-runtime.js';
import { ThreadsError } from './types.js';
import { postTarget } from './urls.js';
import { WorkflowStore, type Draft, type DraftInput, type PublishContext, type PublishOutcome, type WorkflowJob } from './workflows.js';

type Args = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new ThreadsError('INVALID_WORKFLOW', 'Use the supported remote workflow fields and an exact Threads username.'); }
function object(value: unknown): Args { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Args; }
function shape(value: Args, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid();
}
function id(value: unknown): string { if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value; }
function account(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9_.]{1,30}$/.test(value)) invalid(); return value.toLowerCase(); }
function safeCode(error: unknown): string { return error instanceof ThreadsError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'REMOTE_WORKFLOW_FAILED'; }
function jobView(job: WorkflowJob): WorkflowJob { const value = structuredClone(job); delete value.ownerPid; delete value.ownerToken; return value; }
function postUrl(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return checkedRemoteSocialRequest({ kind: 'reply', targetUrl: value }, true).targetUrl;
}
function remoteDraft(value: unknown): DraftInput {
  const input = object(value); shape(input, ['text'], ['replyUrl', 'quoteUrl', 'mediaToken']);
  if (typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 500 || (input.replyUrl !== undefined && input.quoteUrl !== undefined)) invalid();
  const result: DraftInput = { text: input.text };
  if (input.replyUrl !== undefined) result.replyUrl = postUrl(input.replyUrl);
  if (input.quoteUrl !== undefined) result.quoteUrl = postUrl(input.quoteUrl);
  if (input.mediaToken !== undefined) {
    if (typeof input.mediaToken !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.mediaToken)) invalid();
    result.mediaToken = input.mediaToken;
  }
  return result;
}
function protect(root: string): void {
  for (let path = root;; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ThreadsError('WORKFLOW_STORAGE_UNSAFE', 'Remote workflow storage must not use links.');
    if (dirname(path) === path) break;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { chmodSync(root, 0o700); return; }
  const helper = fileURLToPath(new URL('../scripts/windows/Assert-PrivatePaths.ps1', import.meta.url));
  const child = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-StateDir', root, '-ConfigPath', join(root, 'policy.json'), '-TokenFile', join(root, 'unused.token'), '-ProtectState'],
    { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  if (child.status !== 0 || child.error) throw new ThreadsError('WORKFLOW_STORAGE_ACL_REQUIRED', 'Remote workflow storage requires private permissions.');
}

/** Explicitly run, durable workflows; no timer or background publication is installed. */
export class RemoteWorkflowController {
  private readonly root: string;
  private readonly stores = new Map<string, WorkflowStore>();
  private readonly authorized = new Set<string>();
  private generation = 0;
  private closed = false;
  private running = false;
  private active?: { accountId: string; id: string; generation: number; store: WorkflowStore };
  constructor(private readonly service: ThreadsService, private readonly rawDriver: BrowserDriver,
    private readonly social: RemoteSocialController, private readonly assertAccess: () => void,
    private readonly media?: RemoteMediaController) {
    this.root = resolve(service.config.dataDir, 'remote-workflows'); protect(this.root);
  }
  private check(generation = this.generation): void {
    this.assertAccess();
    if (this.closed || generation !== this.generation) throw new ThreadsError('REMOTE_WORKFLOW_REVOKED', 'Remote workflow authorization changed.');
    if (!this.service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Remote workflows require enabled controlled writes.');
  }
  private args(value: unknown, required: string[], optional: string[] = []): Args & { accountId: string } {
    this.check(); const args = object(structuredClone(value)); shape(args, ['accountId', ...required], optional);
    return { ...args, accountId: account(args.accountId) };
  }
  private store(accountId: string): WorkflowStore {
    let store = this.stores.get(accountId);
    if (!store) {
      store = new WorkflowStore({ dataDir: this.root, accountId });
      // An authorization from another host lifetime or credential epoch never resumes.
      for (const job of store.listSchedules()) if (['authorized', 'running'].includes(job.status)) store.cancelSchedule(job.id);
      this.stores.set(accountId, store);
    }
    return store;
  }
  private async viewer(accountId: string, generation: number): Promise<PageRead> {
    this.check(generation);
    return this.service.serial(async () => {
      this.check(generation); const page = await this.rawDriver.command<PageRead>({ type: 'read' });
      this.check(generation); assertRemoteViewer(page, accountId); return page;
    });
  }
  private request(draft: DraftInput, previousPostUrl?: string): SocialRequest {
    const clean = remoteDraft({ text: draft.text, ...(draft.replyUrl ? { replyUrl: draft.replyUrl } : {}), ...(draft.quoteUrl ? { quoteUrl: draft.quoteUrl } : {}), ...(draft.mediaToken ? { mediaToken: draft.mediaToken } : {}) });
    // Persisted local/API media fields must never gain remote capabilities.
    if (draft.media !== undefined || draft.replyTo !== undefined || draft.quotePostId !== undefined) invalid();
    const reply = previousPostUrl ?? clean.replyUrl;
    return checkedRemoteSocialRequest({ kind: clean.quoteUrl ? 'quote' : reply ? 'reply' : 'publish', targetUrl: clean.quoteUrl ?? reply ?? 'https://www.threads.com/', text: clean.text,
      ...(clean.mediaToken ? { mediaToken: clean.mediaToken } : {}) }, false, !!this.media);
  }
  private mediaCheck(request: SocialRequest, accountId: string): void {
    if (!request.mediaToken) return;
    if (!this.media) throw new ThreadsError('REMOTE_MEDIA_DISABLED', 'Remote staged media is not enabled.');
    this.media.authorize(request, accountId);
  }
  async saveDraft(value: unknown): Promise<Draft> {
    const args = this.args(value, ['draft'], ['id']), generation = this.generation;
    const draft = remoteDraft(args.draft); const request = this.request(draft);
    await this.viewer(args.accountId, generation); this.mediaCheck(request, args.accountId); this.check(generation);
    return this.store(args.accountId).saveDraft(draft, args.id === undefined ? undefined : id(args.id));
  }
  async listDrafts(value: unknown): Promise<Draft[]> {
    const args = this.args(value, []), generation = this.generation; await this.viewer(args.accountId, generation); return this.store(args.accountId).listDrafts();
  }
  async deleteDraft(value: unknown): Promise<{ deleted: boolean }> {
    const args = this.args(value, ['id']), generation = this.generation; const draftId = id(args.id);
    await this.viewer(args.accountId, generation); return { deleted: this.store(args.accountId).deleteDraft(draftId) };
  }
  async stageSchedule(value: unknown): Promise<WorkflowJob> {
    const args = this.args(value, ['draftIds', 'at'], ['dedupeKey']), generation = this.generation;
    if (!Array.isArray(args.draftIds) || args.draftIds.length < 1 || args.draftIds.length > 20 || typeof args.at !== 'string' || (args.dedupeKey !== undefined && typeof args.dedupeKey !== 'string')) invalid();
    const draftIds = args.draftIds.map(id); await this.viewer(args.accountId, generation);
    const store = this.store(args.accountId);
    for (const draftId of draftIds) {
      const draft = store.getDraft(draftId); if (!draft) throw new ThreadsError('DRAFT_NOT_FOUND', 'A draft is absent for this account.');
      this.mediaCheck(this.request(draft), args.accountId);
    }
    this.check(generation); return jobView(store.stageSchedule({ draftIds, at: args.at, ...(args.dedupeKey ? { dedupeKey: args.dedupeKey as string } : {}) }));
  }
  async listSchedules(value: unknown): Promise<WorkflowJob[]> {
    const args = this.args(value, []), generation = this.generation; await this.viewer(args.accountId, generation); return this.store(args.accountId).listSchedules().map(jobView);
  }
  async authorizeSchedule(value: unknown): Promise<WorkflowJob> {
    const args = this.args(value, ['id']), generation = this.generation; const jobId = id(args.id);
    await this.viewer(args.accountId, generation); const store = this.store(args.accountId), job = store.getSchedule(jobId);
    for (let index = 0; index < job.parts.length; index++) {
      const part = job.parts[index]; if (part.status === 'confirmed') continue;
      const previous = index ? job.parts[index - 1].outcome : undefined;
      // A token cannot target an as-yet unpublished chain parent.
      if (part.draft.mediaToken && index > 0 && previous?.status !== 'confirmed') throw new ThreadsError('MEDIA_CHAIN_TARGET_UNKNOWN', 'Stage chain media only after the preceding part is confirmed.');
      this.mediaCheck(this.request(part.draft, previous?.status === 'confirmed' ? previous.postUrl : undefined), args.accountId);
    }
    this.check(generation); const result = store.authorizeSchedule(jobId); this.authorized.add(`${args.accountId}:${jobId}`); return jobView(result);
  }
  async cancelSchedule(value: unknown): Promise<WorkflowJob> {
    const args = this.args(value, ['id']), generation = this.generation; const jobId = id(args.id);
    await this.viewer(args.accountId, generation); this.authorized.delete(`${args.accountId}:${jobId}`); return jobView(this.store(args.accountId).cancelSchedule(jobId));
  }
  /** Narrow busy-request path: only stop the exact in-flight job; never touch the browser. */
  cancelRunning(value: unknown): WorkflowJob {
    const args = this.args(value, ['id']), jobId = id(args.id), active = this.active;
    if (!active || active.accountId !== args.accountId || active.id !== jobId || active.generation !== this.generation)
      throw new ThreadsError('SCHEDULE_NOT_RUNNING', 'Only the currently active account and job can be cancelled through the busy path.');
    this.check(active.generation); this.authorized.delete(`${args.accountId}:${jobId}`);
    return jobView(active.store.cancelSchedule(jobId));
  }
  private stopped(store: WorkflowStore, context: PublishContext, generation: number): void {
    this.check(generation);
    if (!this.authorized.has(`${context.accountId}:${context.jobId}`)) throw new ThreadsError('REMOTE_WORKFLOW_REVOKED', 'The job has no authorization in this credential epoch.');
    if (store.getSchedule(context.jobId).cancelRequested) throw new ThreadsError('STOP_REQUESTED', 'The workflow was cancelled before its next effect.');
  }
  private async publish(store: WorkflowStore, draft: Draft, context: PublishContext, generation: number): Promise<PublishOutcome> {
    let executeStarted = false;
    try {
      this.stopped(store, context, generation);
      if (draft.accountId !== context.accountId || (context.partIndex > 0 && (!context.previousPostUrl || draft.replyUrl || draft.quoteUrl))) invalid();
      const request = this.request(draft, context.previousPostUrl); this.mediaCheck(request, context.accountId);
      await this.service.waitForWriteSlot({ shouldStop: () => { this.stopped(store, context, generation); return false; } });
      this.stopped(store, context, generation); this.mediaCheck(request, context.accountId);
      await this.viewer(context.accountId, generation); this.stopped(store, context, generation);
      const prepared = await this.social.prepare({ ...request, expectedAccount: context.accountId });
      this.stopped(store, context, generation); this.mediaCheck(request, context.accountId);
      if (prepared.account !== context.accountId || prepared.request.kind !== request.kind || prepared.request.text !== request.text ||
          prepared.request.mediaToken !== request.mediaToken || !sameThreadsRoute(prepared.request.targetUrl, request.targetUrl)) throw new ThreadsError('WORKFLOW_PREPARATION_MISMATCH', 'Prepared content does not match the immutable authorized draft.');
      executeStarted = true; const result = await this.social.execute(prepared.id, context.accountId, () => this.stopped(store, context, generation));
      this.check(generation);
      const after = result.after;
      if (result.outcome !== 'verified' || !result.verified || !result.dispatch?.dispatched || result.dispatch.noop || !after?.verified || !after.postUrl)
        return { status: 'uncertain', evidence: ['The single-use execution did not prove a new publication; no replay is allowed.'] };
      const url = postUrl(after.postUrl), author = new URL(url).pathname.split('/')[1]?.slice(1).toLowerCase();
      if (author !== context.accountId || after.account !== context.accountId || !sameThreadsRoute(after.targetUrl, request.targetUrl) || sameThreadsRoute(url, request.targetUrl))
        return { status: 'uncertain', evidence: ['Returned publication did not match the authorized account and target; no replay is allowed.'] };
      return { status: 'confirmed', postId: postTarget(url).code, postUrl: url, evidence: [`Verified new ${request.kind} at ${url} after a single reviewed execution.`] };
    } catch (error) {
      return { status: executeStarted ? 'uncertain' : 'failed', evidence: [`Remote workflow stopped ${executeStarted ? 'after execution may have started; never replay' : 'before execution'} (${safeCode(error)}).`] };
    }
  }
  async runSchedules(value: unknown): Promise<{ jobs: WorkflowJob[]; maxParts: number; stopReason: string }> {
    const args = this.args(value, [], ['limit']), generation = this.generation;
    const limit = args.limit ?? 2; if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 3) invalid();
    if (this.running) throw new ThreadsError('WORKFLOW_RUNNING', 'A remote workflow run is already active.');
    this.running = true;
    try {
      await this.viewer(args.accountId, generation); const store = this.store(args.accountId), jobs: WorkflowJob[] = [];
      let remaining = 20, stopReason = 'job_limit';
      for (let index = 0; index < Number(limit); index++) {
        this.check(generation);
        const now = new Date().toISOString(), next = store.listSchedules().find(job => job.status === 'authorized' && job.at <= now && this.authorized.has(`${args.accountId}:${job.id}`));
        if (!next) { stopReason = 'no_due_jobs'; break; }
        const count = next.parts.filter(part => part.status !== 'confirmed').length;
        if (count > remaining) { stopReason = 'part_limit'; break; }
        let result: WorkflowJob[];
        this.active = { accountId: args.accountId, id: next.id, generation, store };
        try { result = await store.runDue((draft, context) => this.publish(store, draft, context, generation), { writesEnabled: true, limit: 1, now }); }
        finally { this.active = undefined; }
        jobs.push(...result); remaining -= count;
        for (const job of result) this.authorized.delete(`${args.accountId}:${job.id}`);
        if (result.some(job => job.status !== 'confirmed')) { stopReason = 'job_stopped'; break; }
      }
      return { jobs: jobs.map(jobView), maxParts: 20, stopReason };
    } finally { this.running = false; if (this.closed) this.closeStores(); }
  }
  async reconcileSchedule(value: unknown): Promise<WorkflowJob> {
    const args = this.args(value, ['id', 'outcome']), generation = this.generation; const jobId = id(args.id), input = object(args.outcome);
    if (!['confirmed', 'failed'].includes(String(input.status))) invalid();
    shape(input, input.status === 'confirmed' ? ['status', 'postUrl', 'evidence'] : ['status', 'evidence']);
    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 10 || input.evidence.some(value => typeof value !== 'string' || !value.trim() || value.length > 1000)) invalid();
    const evidence = input.evidence as string[];
    await this.viewer(args.accountId, generation); const store = this.store(args.accountId), job = store.getSchedule(jobId);
    if (job.status !== 'uncertain') throw new ThreadsError('SCHEDULE_STATE', 'Only an uncertain schedule can be reconciled.');
    if (input.status === 'failed') { this.check(generation); return jobView(store.reconcileSchedule(jobId, { status: 'failed', evidence })); }
    const url = postUrl(input.postUrl);
    if (new URL(url).pathname.split('/')[1]?.slice(1).toLowerCase() !== args.accountId) throw new ThreadsError('ACCOUNT_MISMATCH', 'Reconciliation needs this account\'s resulting post.');
    const part = job.parts.find(part => part.status === 'uncertain' || part.status === 'publishing');
    if (!part || job.parts.indexOf(part) > 0 || part.draft.replyUrl || part.draft.quoteUrl || part.draft.mediaToken)
      throw new ThreadsError('RECONCILIATION_DIMENSIONS_UNVERIFIED', 'Fresh text and permalink alone cannot establish reply/quote relationships or attachment contents; this outcome must remain uncertain.');
    await this.service.serial(async () => {
      this.check(generation); let page = await this.rawDriver.command<PageRead>({ type: 'read' });
      this.check(generation); assertRemoteViewer(page, args.accountId);
      if (!sameThreadsRoute(page.url, url)) {
        assertRemoteDraftSafe(page); await this.rawDriver.command({ type: 'navigate', url }); this.check(generation);
        page = await this.rawDriver.command<PageRead>({ type: 'read' }); this.check(generation); assertRemoteViewer(page, args.accountId);
      }
      if (!sameThreadsRoute(page.url, url) || !page.posts?.some(post => sameThreadsRoute(post.url, url) && post.author.username.toLowerCase() === args.accountId && post.text === part?.draft.text))
        throw new ThreadsError('RECONCILIATION_NOT_OBSERVED', 'The account, exact post URL and immutable draft text must be freshly observed.');
    });
    this.check(generation); return jobView(store.reconcileSchedule(jobId, { status: 'confirmed', postId: postTarget(url).code, postUrl: url, evidence: [...evidence, 'Fresh selected-tab observation matched the resulting post author, permalink and immutable draft text.'] }));
  }
  invalidate(): void {
    this.generation++; this.authorized.clear();
    for (const store of this.stores.values()) for (const job of store.listSchedules()) if (['authorized', 'running'].includes(job.status)) store.cancelSchedule(job.id);
  }
  private closeStores(): void { for (const store of this.stores.values()) store.close(); this.stores.clear(); }
  close(): void { if (this.closed) return; this.invalidate(); this.closed = true; if (!this.running) this.closeStores(); }
}
