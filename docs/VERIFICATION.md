# Verification and limits

The runtime is version 0.4.2, revision `20261024-readiness-3`.

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
