import type { ThreadsService } from './service.js';
import { sameThreadsRoute } from './service.js';
import type { SocialActions } from './social-actions.js';
import type { SocialRequest } from './social-runtime.js';
import type { PageRead, PageSnapshot } from './page-runtime.js';
import type { Draft, PublishContext, PublishOutcome } from './workflows.js';
import { ThreadsError } from './types.js';
import { handle, postTarget } from './urls.js';

export type BrowserPublishContext = PublishContext & { previousPostUrl?: string };
export interface BrowserPublishOptions { shouldStop?: () => boolean; sleep?: (ms:number)=>Promise<void>; }
/** A commit may have been sent. WorkflowStore must leave the part uncertain and never replay it. */
export class BrowserPublishingError extends ThreadsError {
  readonly outcome = 'unknown';
  constructor(code: string, public readonly evidence: string[]) {
    super(code, 'Browser publication outcome is uncertain. Preserve the staged draft and inspect the account before any new attempt.', false);
  }
}
type BrowserService = Pick<ThreadsService, 'browserRead' | 'serial' | 'driver' | 'config' | 'waitForWriteSlot'>;
type SocialPublisher = Pick<SocialActions, 'prepare' | 'execute'>;
function canonicalPost(value: string): string {
  const parsed = postTarget(value);
  const url = new URL(parsed.url);
  if (!/^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)) throw new ThreadsError('BROWSER_POST_URL_REQUIRED', 'Use the exact author-qualified Threads post URL.');
  url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}
function accountName(value: string): string {
  if (/^\d+$/.test(value.trim())) throw new ThreadsError('BROWSER_USERNAME_REQUIRED', 'Browser workflows require a username, not a numeric API account ID. Prefix a genuinely numeric username with @.');
  return handle(value);
}

/**
 * Call OUTSIDE service.serial. This adapter performs one public browserRead, then owns
 * the service mutex across recheck/navigation/stage/commit. Inner reads use the driver
 * directly to avoid recursively acquiring the non-reentrant service mutex.
 */
export async function publishBrowserDraft(service: BrowserService, social: SocialPublisher, draft: Draft,
  context: BrowserPublishContext, options: BrowserPublishOptions = {}): Promise<PublishOutcome> {
  const evidence: string[] = [];
  let commitStarted = false;
  const stop = () => { if (options.shouldStop?.()) throw new ThreadsError('STOP_REQUESTED', 'Publication stopped before the next browser operation.'); };
  const failed = (code: string): PublishOutcome => ({ status: 'failed', evidence: [...evidence, `Browser publication stopped before commit (${code}); no publication was attempted.`] });
  let expected: string;
  let request: SocialRequest;
  try {
    if (!service.config.writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Browser publication requires the explicit enabled write setting.');
    stop();
    expected = accountName(context.accountId);
    if (accountName(draft.accountId) !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Draft account differs from the authorized workflow account.');
    if (draft.media?.some(item => item.altText !== undefined)) throw new ThreadsError('BROWSER_ALT_TEXT_UNSUPPORTED', 'Scheduled browser alt text is not supported.');
    if (draft.media?.length) throw new ThreadsError('BROWSER_SCHEDULE_MEDIA_UNSUPPORTED', 'Scheduled browser media requires verified attachment handling; no upload or navigation was attempted.');
    if (typeof draft.text !== 'string' || !draft.text.trim() || [...draft.text].length > 500) throw new ThreadsError('INVALID_DRAFT', 'Browser publication requires nonempty text of at most 500 Unicode characters.');
    if (draft.quotePostId) throw new ThreadsError('BROWSER_QUOTE_URL_REQUIRED', 'Use a quote URL alone for a browser workflow; numeric API quote IDs cannot establish the browser target.');
    const replyUrlInput = (draft as Draft & { replyUrl?: string }).replyUrl;
    const rootReply = replyUrlInput ?? context.replyTo ?? draft.replyTo;
    if (context.previousPostUrl && context.partIndex < 1) throw new ThreadsError('INVALID_CHAIN_CONTEXT', 'A previous-post URL is valid only for a later chain part.');
    if (context.partIndex > 0 && !context.previousPostUrl) throw new ThreadsError('BROWSER_CHAIN_URL_REQUIRED', 'A later chain part requires the prior confirmed post URL.');
    if (context.partIndex > 0 && (draft.replyTo || replyUrlInput || draft.quoteUrl)) throw new ThreadsError('INVALID_CHAIN_CONTEXT', 'Later chain parts cannot override their previous-post target.');
    const replyUrl = context.previousPostUrl ?? rootReply;
    if (replyUrl && draft.quoteUrl) throw new ThreadsError('INVALID_DRAFT', 'Choose a reply target or quote target.');
    if (replyUrl && !/^https:\/\//i.test(replyUrl)) throw new ThreadsError('BROWSER_REPLY_URL_REQUIRED', 'A numeric or short post ID is insufficient; provide the exact reply URL or previous confirmed chain URL.');
    request = { kind: draft.quoteUrl ? 'quote' : replyUrl ? 'reply' : 'publish',
      targetUrl: draft.quoteUrl ? canonicalPost(draft.quoteUrl) : replyUrl ? canonicalPost(replyUrl) : 'https://www.threads.com/', text: draft.text };
    const initial = await service.browserRead();
    if (!initial.viewer.username || handle(initial.viewer.username) !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Selected browser account differs from the authorized account.');
    stop();
  } catch (error) { return failed(error instanceof ThreadsError ? error.code : 'BROWSER_PREFLIGHT_FAILED'); }

  try {
    return await service.serial(async () => {
      stop();
      // Wait before any navigation or composer staging. Recheck account/draft after
      // waiting, and reserve only once at SocialActions.execute immediately before commit.
      await service.waitForWriteSlot({shouldStop:options.shouldStop,sleep:options.sleep});
      stop();
      const current = await service.driver.command<PageRead>({ type: 'read' });
      if (!current.viewer.username || handle(current.viewer.username) !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Account changed before browser staging.');
      // Navigation must never discard a user's draft or overlay. Empty classified
      // inline composers and global search controls do not themselves prove a draft.
      const snapshot = await service.driver.command<PageSnapshot>({ type: 'snapshot' });
      if (!snapshot.viewer.username || handle(snapshot.viewer.username) !== expected || !sameThreadsRoute(snapshot.url, current.url)) throw new ThreadsError('SOURCE_CHANGED', 'Browser source changed during preflight.');
      const composer = (current as PageRead & { composerState?: { present: boolean; nonempty: boolean; attachments: boolean; ambiguous: boolean } }).composerState;
      const unclassifiedEditable = snapshot.elements.some(element => element.editable && element.role !== 'searchbox' && !/^(?:search|search threads|搜尋|搜尋 threads|搜尋脆)$/i.test(element.name?.trim() ?? ''));
      const unsafeComposer = composer ? [composer.present, composer.nonempty, composer.attachments, composer.ambiguous].some(value => typeof value !== 'boolean' || value) : unclassifiedEditable;
      if (current.dialogState.present || unsafeComposer) throw new ThreadsError('BROWSER_DRAFT_PRESENT', 'An existing dialog, draft, attachment or unclassified editor must be resolved before scheduled browser publication.');
      if (!sameThreadsRoute(current.url, request.targetUrl)) {
        stop();
        await service.driver.command({ type: 'navigate', url: request.targetUrl });
      }
      const target = await service.driver.command<PageRead>({ type: 'read' });
      if (!sameThreadsRoute(target.url, request.targetUrl)) throw new ThreadsError('SOURCE_CHANGED', 'Browser did not reach the exact authorized target.');
      if (!target.viewer.username || handle(target.viewer.username) !== expected) throw new ThreadsError('ACCOUNT_MISMATCH', 'Account changed while navigating to the target.');
      stop();
      const prepared = await social.prepare(request);
      if (handle(prepared.account) !== expected || prepared.request.kind !== request.kind || !sameThreadsRoute(prepared.request.targetUrl, request.targetUrl) || prepared.request.text !== draft.text || prepared.request.mediaToken)
        throw new ThreadsError('BROWSER_PREPARATION_MISMATCH', 'Prepared account, target or content differs from the authorized draft.');
      evidence.push(`Prepared ${request.kind} for the exact authorized account, target and text.`);
      stop();
      commitStarted = true;
      const result = await social.execute(prepared.id, expected);
      const after = result.after;
      if (!result.verified || result.outcome !== 'verified' || !after?.verified || !after.postUrl || !result.dispatch?.dispatched || result.dispatch.noop)
        throw new BrowserPublishingError('BROWSER_PUBLICATION_UNCERTAIN', [...evidence, 'The one-shot social action did not establish a verified new publication. No commit was replayed.']);
      const postUrl = canonicalPost(after.postUrl);
      const author = new URL(postUrl).pathname.match(/^\/@([^/]+)\/post\//)?.[1];
      if (!author || handle(author) !== expected || handle(after.account) !== expected || !sameThreadsRoute(after.targetUrl, request.targetUrl) || sameThreadsRoute(postUrl, request.targetUrl))
        throw new BrowserPublishingError('BROWSER_PUBLICATION_MISMATCH', [...evidence, 'The returned publication did not match the authorized account or target. No commit was replayed.']);
      evidence.push(`Verified new browser publication ${postUrl}.`, 'SocialActions established the exact text and intended action; no automatic retry was performed.');
      return { status: 'confirmed', postId: postTarget(postUrl).code, postUrl, evidence };
    });
  } catch (error) {
    if (error instanceof BrowserPublishingError) throw error;
    if (commitStarted && error instanceof ThreadsError && ['WRITES_DISABLED', 'INVALID_ACTION', 'EXPIRED_ACTION', 'ACCOUNT_MISMATCH', 'ACTION_COOLDOWN'].includes(error.code)) return failed(error.code);
    if (commitStarted) throw new BrowserPublishingError('BROWSER_PUBLICATION_UNCERTAIN', [...evidence, 'Execution or verification ended without a reliable result. No commit was replayed.']);
    return failed(error instanceof ThreadsError ? error.code : 'BROWSER_PRECOMMIT_FAILED');
  }
}
