# Verification and limits

Current source runtime: v0.7.0, revision `20261107-profile-label-1`. Dated activation results below are separate from source version.

## Public export checks (2026-11-06, Windows)

The exported source passed typecheck, build, the 44-tool stdio smoke and the default test suite: **197 passed, 6 skipped, 0 failed**, final exit 0. Browser fixture opt-in was disabled for this export check; existing dependency installations were reused. This does not establish a clean cloud install or a new authenticated Threads session. The private account state and internal worklog were excluded before publishing.

## Existing maintainer evidence (2026-10-24, Windows)

- Full offline/isolated-browser suite: 231 passed, one platform-inapplicable skip, zero failures.
- Typecheck, build and 44-tool stdio MCP smoke passed.
- Selected-tab native acceptance covered profile/post/reply reads, observed liker/reposter lists, notifications, followers/following, social state inspection, already-satisfied no-op execution, preparation without publication/deletion, and a subsequent read cycle.
- Five native background workflows observed the tab hidden both before and after execution.

These are dated results, not a guarantee that Threads' current UI or another operating system behaves identically. Private page captures, account data and internal operational reports are deliberately absent from this repository.

## Reproduce locally

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:mcp
```

Browser fixture tests require Chrome and `THREADS_BROWSER_TESTS=true`. They use isolated fixtures rather than changing a real Threads account. Native acceptance is opt-in and requires an explicitly paired, logged-in browser. `npm run test:browser` additionally requires `THREADS_TEST_FOLLOWING_USERNAME` to name an account the test viewer already follows; it never creates that relationship to pass a check.

Real publication, deletion, follow changes, media upload and scheduled publication were not used as live acceptance tests. These paths have implementation and fixture coverage; do not represent that as verified real-account writes. The maintainer did not perform Grok-side acceptance; the owner reported successful command-wrapper deployment on 2026-11-06. Read [GROK-BOT.md](GROK-BOT.md) for installation and acceptance requirements.
# Remote HTTP update — 2026-11-06

Reliability follow-up: 215 default tests passed, 6 conditional/browser tests skipped, zero failures; typecheck, build and 44-tool stdio smoke passed. Windows coverage includes isolated child crash/restart, PowerShell 5.1 parsing/init/private ACL, actual junction rejection with outside ACL unchanged, bounded health deadlines and lock release after persistence failure. A separate published-package fixture connected mcp-remote 0.16.1 through a private header file to the 15-tool HTTP endpoint without browser/account access. Independent review blockers were corrected and rechecked.

These checks do not establish installed login tasks, real managed-tunnel routing, or live deployment of this update. Fresh `/healthz` diagnostics, bridge-restart recovery without replay, and token revocation across HTTP restarts are implemented. A later isolated Chrome-session experiment verified second-page public-profile reads for two targets: five new target-authored posts each, advancing cursors and no scrolling. It is not a production MCP feature; see DIRECT-READ-RESEARCH.md. A separate current-tool profile call with two scroll rounds and its next read both succeeded, but each yielded four posts; that check did not demonstrate additional scrolling yield.

The optional authenticated HTTP endpoint exposes 15 read tools. Typecheck, build and the existing 44-tool stdio smoke passed. Default tests: 200 passed, 6 conditional/browser tests skipped, zero failures. New HTTP tests cover actual client negotiation and calls, authentication and rotation, Host/Origin checks, bounded single-message requests, denied private/write tools, redaction and request serialization. A separate review found no blocking issue in the remote access scope.

The public HTTPS route was exercised from the maintainer's host: unauthenticated requests received 401; authenticated tool listing and two consecutive real profile reads passed. This maintainer-side check is separate from the owner-reported Grok command-wrapper acceptance. Live account data, the endpoint hostname and access tokens are excluded from this repository. No account writes or cookie transfers occurred.

## v0.5.0 production direct profile acceptance — 2026-11-06

Activated host, extension and runtime v0.5.0. Default suite:235 passed,6 conditional skips,0 failures. After the final absolute-origin fix,13 runtime and3 service/HTTP tests passed. Typecheck,build and44-tool stdio checks passed. Independent review closed the origin-binding issue and found no remaining concrete blocker in the scoped implementation.

Actual existing-tool acceptance passed separately over loopback HTTP, public HTTPS and mcp-remote0.16.1 with a private header file. Each collected4 public-profile pages (4+5+5+5=19 unique posts), followed by3 viewer-profile pages (4+5+5=14). Later cursors advanced, authors matched, remote tool count stayed15 and writes remainedfalse. All were bounded page_limit results with hasNexttrue and completenesspartial. Original route restored; final visibility hidden. No cookies were extracted/transferred, no account writes occurred, and temporary header file was removed. The wrapper ran on the maintainer machine; the owner's Grok process must refresh its schema and verify its next call.

An initial assertion-only harness failure was retained without enough pagination details to establish its exact cause. Per-call diagnostic recording was improved before the three complete passes above. The implementation does not guarantee all future sessions or full history. Search/replies/connections direct pagination and cross-call continuation are not implemented.

## v0.5.1 controlled remote writes — 2026-11-06

Default suite257PASS6conditionalSKIP0FAIL; typecheck/build/44-tool stdio smoke passed. Explicit controlled mode has18tools; default remains15. Fixture coverage proves preparation across stateless HTTP requests, account/draft/target binding, expiry/single-use/shared cooldown, uncertain-outcome no replay and revocation at asynchronous dispatch boundaries. Slow request bodies cannot inherit a newer bearer epoch. Independent review closed both credential timing issues.

The deployed public HTTPS endpoint reported18tools and writesEnabledtrue; anonymous requests remained401. Actual named inspect/prepare/execute acceptance used ONLY an already-satisfied action: nooptrue, dispatchedfalse, stateunchanged. Reuse of the consumed ID failed; a subsequent direct profile read returned2pages9posts and the original hidden route was restored. No social mutation, publication, deletion, media upload or private message was performed. This verifies activation and no-op safeguards, not actual publication of content. The owner's Grok process must refresh its tool schema.

## v0.6.0 controlled remote media — 2026-11-06

Selected client-byte uploads, with a separate remote-media opt-in. Default15/read-only and writes-only18 remain; both flags expose19 tools. No filesystem path reader, official API, delete, DM, generic UI or port19758 exposure was added. Host uploads use generated private filenames, strict chunk/size/signature/hash limits and durable consumed-finish receipts.

Default suite: **279 passed,8 conditional/browser/proxy skips,0 failed**, finalexit0. Typecheck,build and44-tool stdio smoke passed. Focused core10/social19/Windows11 tests passed. The isolatedChrome affected suite passed25 tests; the final PNG fixture was corrected to valid CRCs and explicitly required successful image decoding. It verified exact bytes in the File input, visible preview, text/media preparation and one commit for publish/reply/quote. All test-browser network traffic was intercepted. The separately enabled actualmcp-remote0.16.1/header-file HTTP fixture passed5 tests, including byte transfer, prepare→reviewID→single dispatch, status after uncertain finish,429/health behavior and revocation before file assignment. Independent source/contract review found no blocker.

The browser verifier deliberately cannot match uploaded bytes to platform-rendered media: an observed exact-caption post with media remains publication-observed-media-unverified/outcome-uncertain. No automatic retry is authorized. Fixture execution is not real-account publication verification.

The current publicHTTPS host was restarted with both flags and returned19 tools,writesEnabledtrue,mediaEnabledtrue,anonymous401 and connected bridge. The owner reloaded/reconnected the selected tab. Fresh native reads verified extension/runtime both0.6.0,revision20261106-remote-media-1 and remoteMediaVersion1. Actual publicHTTPS activation acceptance completed at2026-11-06T11:05:03Z:19tools,writesEnabledtrue,mediaEnabledtrue,anonymous401; two consecutive exact-account profile reads returned2pages9posts then1page4posts,allpartial. The selected tab stayed hidden,connection remained active,and its original route was restored. No real-account media upload or publication was performed. Grok must reconnect/refresh its schema; the maintainer has not controlled the owner's Grok process. Windows supervisor supports the new default-false flag, but no login task or persistent configuration was installed.

An initial CLI fixture startup timeout and observation-navigation cascade were retained as transient test failures; isolated reruns passed3/3 and26/26 on the same source. Guardian's wrapper reported WinError5 and its own fallback; successful local tests do not prove Guardian job coverage.


## v0.7.0 controlled remote parity — 2026-11-06

The original 15/18/19 remote modes remain available. Six independent capability groups add extended feeds/notifications/collection analytics, separate final-delete preparation and execution, remote drafts and browser schedules/chains, vetted public navigation, private messages-route reads, and optional official API. All groups enabled expose 44 remote tools. Local arbitrary UI interaction, local-path media, filesystem export and browser account-insights tools are not exposed remotely. API credentials remain host-owned and optional.

Final required verification completed with exit 0: typecheck, production build, 44-tool stdio MCP smoke, and the complete npm test suite with intercepted Chrome and actual mcp-remote/header-file fixture opt-ins: **395 passed, 1 platform-inapplicable skip, 0 failed (396 total)**. The test command limits file concurrency to two. Tests exercise the old modes, all 44 tools, cross-client preparations and immutable schedules, private-view corpus isolation, delayed native preflight revocation, cancellation before/after dispatch, single-use confirmation, manual takeover and document replacement, and per-dispatch API revocation. The actual media proxy fixture still exercises the prior 19-tool byte-upload contract. Independent source review reported no remaining concrete blocker after targeted corrections.

An earlier full run had a stale assertion expecting the old navigate command after guarded remote_view was introduced; it was corrected and the final full run passed. One earlier focused cancellation HTTP run had a transient ECONNRESET of unknown cause; its unchanged focused rerun and final full suite passed. Guardian wrappers reported unavailable job coverage and their local fallback; no enforcement coverage is claimed.

Activation accepted on 2026-11-07 after the owner reloaded/re-paired the extension. Native reads verified extension/runtime v0.7.0 and runtime revision `20261107-profile-label-1`. Public HTTPS and the actual mcp-remote 0.16.1/header-file path each completed with exit 0: anonymous 401, authenticated 44-tool schema, writes/media true, all six capability flags true, two exact-account profile reads (2 pages/9 posts followed by 1 page/4 posts, both partial), and a bounded public-navigation snapshot with 32 refs. The selected tab stayed hidden, the original route was restored, and the bridge remained connected. API status truthfully returned configured=false, authentication=not_checked and writeIdentityConfigured=false. No real publication, deletion, media upload, private message/notification read or scheduled job was used to test the release. The existing bearer and tunnel were preserved. Grok schema refresh is still a client-side step; these checks ran on the maintainer host.

The first activation attempt read profiles successfully but the new restricted snapshot returned ACCOUNT_UNVERIFIED. Its account label reader lacked the SVG title formats supported by the existing reader. The repair accepts visible owned icon labels, rejects conflicting/hidden/nested evidence, and restricts unlabelled text to the anchor's own text nodes. Independent focused review closed the nested-text issue. The final affected isolated Chrome suite passed 15/15, and typecheck/build/44-tool stdio checks passed. The acceptance script also corrected its StdioClientTransport import to the SDK stdio subpath. The initial failure report is retained privately; subsequent complete HTTPS and proxy runs both passed. This runtime-only repair required no further extension reload or service restart.

The new final-delete result deliberately stays outcome-uncertain; absence alone is not deletion proof. Browser alt text remains unsupported. Media approvals are short-lived and bound to the current composer, so remote draft storage does not establish durable media scheduling. Reply/quote/media uncertainty halts a chain and cannot be promoted by matching text alone. Remote schedule execution requires an explicit caller and does not install a timer or guarantee punctuality. Manual acceptance steps are in REMOTE-MCP.md.
