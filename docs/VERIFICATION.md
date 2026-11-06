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

Real publication, deletion, follow changes, media upload and scheduled publication were not used as live acceptance tests. These paths have implementation and fixture coverage; do not represent that as verified real-account writes. Grok Bot deployment has not been live-verified. Read [GROK-BOT.md](GROK-BOT.md) for installation and acceptance requirements.
