# Observations and bounded analysis

`ThreadsObservations` adds local continuation checkpoints, a reply inbox, sampled trend queries and metric snapshots. Runtime files are stored in the configured private data directory as `observations.json`; they must remain outside Git. All browser operations use the selected account/tab through `ThreadsService`. These features do not read direct messages or perform social writes.

## Notification evidence

The runtime supplies `NotificationRowEvidence` for individual DOM rows. `normalizeNotificationRows` validates the row-local profile/post links, keeps unknown event kinds, and returns source URL and observation time. Actor handles are never extracted from arbitrary whole-page text. The DOM collector is responsible for genuine row boundaries; post authors and unrelated links must not be presented as actor evidence. Optional `actionText` should contain a separately identified notification action label; without it, action classification is explicitly a row-text candidate. Conflicting action phrases produce `unknown`.

Site event IDs, if actually observed, are hashed. Otherwise the stable identifier is an observation fingerprint over row text, linked actors/targets and time evidence. This only deduplicates identical observations. Relative labels such as `2h` are retained as text and are never converted to invented timestamps; changing relative labels may produce another observation for the same underlying event. Unknown rows do not prove an empty notification inbox. Opening activity can affect read status.

## Incremental collection

`collect({source, target, rounds, checkpoint})` supports keyword search, profile posts and a thread's replies. Each pass compares post identity and content/metric fingerprints with prior observations, returning added, updated and unchanged counts. Checkpoints bind both source/target and the observed signed-in account. Account changes fail before checkpoint persistence. Source URLs, pass count and historical distinct observed count accompany the results.

The continuation mode is **refresh from top**. It revisits bounded page windows and deduplicates results; it is not a Threads pagination cursor, a guarantee of eventual historical coverage, or proof of deletion when a prior item disappears from a window. At most five scroll rounds are allowed per pass. Each pass adds a metric snapshot under its returned `analyticsKey`.

## Reply inbox

`replyInbox` visits at most ten selected account post windows, then collects classified incoming replies and optionally exact-handle mention candidates through existing research. It excludes self-authored replies, deduplicates shared posts and retains every source/reply-root association. Failed source windows are reported. Account identity is checked around each read and before recording the account-scoped collection.

Results have no unread/read state, do not prove that a person is awaiting a response, and do not include pending moderation items unless actually observed through the relevant source. Unknown root post/reply classification remains subject to the profile tab's context. A zero-result inbox has state `unknown` rather than `empty`.

## Analytics and trends

`snapshot` stores observed post count values and optional observed profile follower counts. `analytics` reports per-metric known/missing coverage and compares only matching posts with known metric values in adjacent snapshots. An all-missing metric has a null total and null delta. Different observed subsets cannot be interpreted as growth. The most recent 100 snapshots are retained per key.

`trends` collects up to five bounded keyword samples and records separate query time series. It reports observed authors/posts, known-like totals and missing counts. Query results can overlap and are not representative platform-wide trend measurements, exhaustive search results or a platform popularity ranking. No sentiment model, private analytics or missing historical period is invented.

## Selected-account browser Insights

`accountInsights` opens the selected account's `/insights/` view and permits up to three short additional reads while the summary is loading. It normalizes only exact summary labels and adjacent integer counts/percentage comparisons, with the observed period label. Current label support covers English and Traditional Chinese views, viewers, net followers and interactions. Missing or abbreviated/unrecognized values remain null; other report sections are preserved as visible text rather than guessed into metrics.

Summary snapshots are account-scoped and retained for the latest 100 observations. They are rolling-period report observations, not daily data or reconstructed history. The interface does not imply access to another account's private insights. This browser route needs the user's own authenticated session; it does not need an official-API token. A missing summary is returned as unknown.

## Verification boundary

Unit tests exercise synthetic row isolation, partial coverage, persisted deduplication, account switches, bounded reply visits, missing metrics, sample membership changes, query failures and summary-label extraction. They do not establish current Threads UI compatibility. Root runtime integration and read-only live acceptance must be recorded separately in `docs/WORKLOG.md` and the project verification report.
