# Local drafts, schedules, chains and collection workflows

`src/workflows.ts` provides local workflow primitives. It never starts a timer or publishes when constructed. The MCP/CLI integration must explicitly invoke `runDue` and supply an authenticated publisher adapter. No live post was created to test this module.

## Drafts and prepared schedules

`new WorkflowStore({dataDir, accountId})` stores drafts, job snapshots, publication outcomes and collection checkpoints in `dataDir/workflows.sqlite`. Use the configured `.threads-data` or `THREADS_DATA_DIR`. Account IDs are stable non-secret identifiers; rows are account scoped. Bind the publisher to the same verified account before execution. A caller selecting another account ID does not authenticate that account.

`saveDraft(input, id?)`, `getDraft`, `listDrafts` and `deleteDraft` manage local content. Text is limited to 500 Unicode code points; media to 20 items. Each media item has `type`, exactly one HTTP(S) `url` or absolute local `path`, and optional `altText`. URLs cannot contain embedded username/password credentials. Local files and remote media must be resolved and validated by the selected publisher at execution time. An API publisher that cannot consume local paths must report that limitation rather than silently omit media. Reply and quote targets are mutually exclusive; use `quotePostId` for a numeric official API target or `quoteUrl` for a browser target.

`stageSchedule({draftIds, at, dedupeKey?})` snapshots 1–20 drafts. Later draft edits or deletions do not alter the prepared content. Time requires an ISO datetime with `Z` or an explicit offset, for example `2026-10-24T18:00:00+08:00`. The job preserves the supplied time and its UTC normalization. Only the first chain part may specify a reply/quote target. A reused dedupe key returns the existing identical prepared schedule and rejects changed content. Dedupe keys apply within an account.

`authorizeSchedule(id)` explicitly authorizes the staged snapshot. `runDue(publisher, {writesEnabled, limit?, now?})` requires the write setting, claims authorized due jobs transactionally, and processes at most 100 jobs per call (default 10). Calling it with writes disabled fails without changing jobs. It does not schedule itself, wake a sleeping computer or guarantee delivery at a specific clock time. Overdue authorized jobs become eligible on the next invocation. The publisher must still enforce its backend write gate, account identity, content support and normal prepared-action protections.

## Outcome evidence and recovery

The injected `Publisher` receives a frozen-in-storage draft snapshot plus `{accountId, jobId, partIndex, idempotencyKey, replyTo?}`. Its result is one of:

- `confirmed` with a real `postId`, optional `postUrl`, and nonempty evidence.
- `failed` with evidence that the operation did not produce the requested effect.
- `uncertain` with evidence explaining why the effect cannot be determined.

The idempotency key is stable for the job part. It is correlation data; this module does not claim that Threads deduplicates requests using it. A thrown exception, malformed outcome or missing confirmation evidence becomes uncertain. There are no automatic retries of failed or uncertain publication. Use `failed` only when the adapter has evidence of failure, rather than a transport timeout after dispatch.

A confirmed chain part supplies the next part's `replyTo` context. Adapters must use this context target when publishing the next part. Outcomes are durably stored after every part. An uncertain/failed part stops the chain. Cancellation before claiming prevents all publication; cancellation during an active dispatch preserves that dispatch's outcome and prevents subsequent parts. Cancellation cannot retract an already dispatched post.

SQLite transactions prevent two processes from claiming the same job. Startup recovery leaves a live process's claims alone. A dead process with a part marked publishing becomes uncertain. A dead process between parts preserves confirmed results and stages remaining content for renewed authorization. Process ownership uses OS PID liveness, so a reused/live PID is handled conservatively and can delay automatic recovery. Opening the store does not replay work.

`reconcileSchedule(id, outcome)` accepts external confirmation or failure evidence for an uncertain part. Confirmation requires its actual post ID. Any remaining chain returns to staged and must be authorized again; confirmed parts are never replayed. Reconciliation should follow a real account read, not a guess. A cancelled chain remains cancelled after its current uncertain part is reconciled.

## Bounded collection and exports

`collectBatch(targets, collect)` accepts 1–20 targets, deduplicates them and collects sequentially. Per-target failures use safe error codes, preserving successful results without leaking raw adapter errors.

`collectIncremental({fetchPage, checkpoint?, maxPages?, maxItems?, onPage?})` follows source-provided opaque cursors. Defaults are 3 pages/100 items; hard limits are 100 pages/5,000 items per call. Page adapters must honor the supplied item bound. Oversized pages fail without advancing the cursor, avoiding data loss from truncation. Duplicate post IDs within the run are removed. A repeated cursor or exhausted bound produces an explicit warning. Source errors propagate and do not claim completion.

`onPage(items, nextCheckpoint)` runs before the in-memory cursor advances. Integration should first commit the posts into the search collection, then call `setCheckpoint(source, nextCheckpoint)`. If the second operation fails, resuming may read the same page again; post upserts must therefore be idempotent. `getCheckpoint` and `setCheckpoint` are account scoped. Checkpoints count observations, not total unique account history. A null cursor means the source window ended; it is not evidence of complete account history. Returned completeness is the final source's assertion for the requested window only.

`exportPosts(posts, 'json'|'csv')` returns real export contents for integration to write to a file or return as a resource. JSON retains null metrics and labels coverage `observed-window-only`. CSV uses CRLF rows, quotes every cell, escapes embedded quotes and retains embedded newlines. Spreadsheet formula prefixes, including leading whitespace/control characters, are neutralized with an apostrophe. Unknown metrics become empty CSV cells, never zero.

## Reference examined

[bintangtimurlangit/threads-mcp schedule tool at commit 2d22286](https://github.com/bintangtimurlangit/threads-mcp/blob/2d22286ef94a31e699c0a7477f450f4fe48009c7/src/tools/schedule.ts) exposes local schedule/list/cancel operations, accepts media and warns that scheduling depends on a running server. That public interface informed the workflow scope. This implementation uses an explicit due runner, timezone offsets, immutable prepared snapshots and a separate authorization step. Its source comparison does not establish live compatibility of either project's publishing backend.

Focused verification: `npx tsx --test tests/workflows.test.ts`; repository verification remains `npm run typecheck`, `npm test`, `npm run build`, `npm run test:mcp`.

## Integrated publisher and worker

publishApiDraft creates authorized text/image/video/carousel containers, polls processing for at most approximately 120 seconds, publishes once and reads the returned post. It verifies account, exact text, media type/count and requested reply/quote IDs. Container and published IDs remain in outcome evidence. Remote transformed bytes are not compared to originals. An explicit API rejection is failed; an ambiguous mutation or read-back after publication is uncertain. No failure silently creates another container or republishes.

MCP tools expose local drafts, staged schedules, authorization, cancellation, run and reconciliation. node dist/cli.js schedule-worker <account> [--once] provides an explicit standalone due runner. It requires configured API credentials and THREADS_ALLOW_WRITES=true, checks every 30 seconds, and reports changed job outcomes only. No OS service or recurring job is installed automatically. A Stop signal is checked before each mutation; already-dispatched publication is still reconciled from its response/read-back. A stopped process or sleeping machine does not guarantee wall-clock execution of due schedules.

### Browser execution in v0.4.0

`threads_run_schedules` now defaults to `provider: browser`; `provider: api` remains explicit. `node dist/cli.js schedule-worker <username> [--once]` uses the already connected selected browser; add `--api` for the older official-API route. Browser jobs require `THREADS_ALLOW_WRITES=true`, the matching username, and an explicitly authorized immutable schedule. No actual job or background timer was started by the implementation work.

Browser scheduling supports text and explicit reply/quote URLs. Use `replyUrl` for a browser root reply; `replyTo` remains the API identifier representation. Ordered chains receive the preceding confirmed post URL. Scheduled browser media and alt text fail before navigation/upload. Existing nonempty/ambiguous composers and attachments block publication; unrelated search fields and positively identified empty inline editors do not. Reply/quote dispatch without verified relationship evidence remains uncertain and stops the chain. See [BROWSER-PUBLISHING.md](BROWSER-PUBLISHING.md).
