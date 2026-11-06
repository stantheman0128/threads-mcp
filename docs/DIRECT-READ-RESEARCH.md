# Direct reads and autonomous exploration

Inspected: **2026-11-06**. This record preserves the research and isolated prototype, and documents the subsequent v0.5.0 implementation contract. **Production activation and multi-page HTTP/HTTPS/header-file-wrapper acceptance passed.** The wrapper ran on the maintainer's host; the owner's Grok process still needs a schema refresh and its own next read.

Scope: support autonomous multi-page exploration and direct data pagination without driving page scrolling, while keeping the existing 15 remote read tool names, no social writes, and no Cookie transfer. The user selected the existing Chrome login. The isolated second-page prototype below preceded the v0.5.0 integration; its success alone does not verify the deployed tool. The optional official API remains unconfigured; no developer token was requested or used.

## v0.5.0 implementation contract and production acceptance

The existing `threads_get_profile` now has an explicit provider choice in the v0.5.0 implementation. `provider:"browser"` remains the default. `provider:"direct"` supports only `section:"posts"` for public profiles, using the selected signed-in Chrome tab; it navigates to the profile and retrieves bounded pages without scrolling or automatic fallback.

```json
{"tool":"threads_get_profile","arguments":{"username":"target_handle","section":"posts","provider":"direct","maxPages":4,"pageSize":5}}
```

`maxPages` accepts 1–5 and defaults to 3, **including the bootstrap page**. `pageSize` accepts 1–20 and defaults to 10 for continuation requests; the website controls the bootstrap window. Direct mode ignores `rounds`. Each call starts fresh; cross-call continuation is not exposed. Session/request credentials remain inside the browser. The remote tool count remains 15, and this path uses no official developer token.

Results always have `completeness:"partial"`. The `pagination` object exposes `provider`, `pagesFetched`, `requests`, `uniquePosts`, `hasNext`, `stopReason`, and `pages`. Each page records `{page, received, added, cursorAdvanced}`. Collected pages include bootstrap; `requests` counts direct continuation attempts. Use later-page `added` counts and cursor advancement to establish useful progress, not the requested budget alone. `hasNext:false` or `end_of_connection` does not establish complete history; null means unknown.

Production verification used the deployed `threads_get_profile` through loopback HTTP, public HTTPS and the actual `mcp-remote@0.16.1` header-file wrapper. Each run collected four public-profile pages: 4 initial posts plus 5 new posts on each of three continuation pages, 19 unique IDs total. The following viewer-profile read collected three pages and 14 unique IDs. All later cursors advanced and all posts matched the target author. Both calls stopped at `page_limit` with `hasNext:true`, preserving `completeness:"partial"`. Runtime and extension versions were both 0.5.0; the original route was restored and final visibility was hidden. No scrolling or social mutations occurred.

The first production harness attempt failed an assertion before recording per-call pagination details. That result was retained; its exact cause was not established. Diagnostic recording was improved, then the three complete runs above passed. This does not establish that every website session or future release will behave identically. See [Grok instructions](GROK-BOT.md#v050-direct-multi-page-public-profile-reads) and [remote contract](REMOTE-MCP.md#direct-public-profile-pagination-v050). Search, replies and follower/following direct pagination are outside this integration.

## Existing autonomous reads

The current browser path already navigates and scrolls automatically; the user does not need to scroll manually. It still depends on the website loading additional content.

| Tool/path | Current bounded behavior |
| --- | --- |
| `threads_search` | Up to five query variants; `rounds` 0–10 per source. |
| `threads_research` | Up to ten source/query visits; `rounds` 0–3; can expand up to three reply threads with at most one scroll round each. |
| `threads_discover` / `threads_search_users` | Top/recent or profile search; `rounds` 0–3. |
| `threads_batch_read` | Up to ten profile/conversation targets, sequentially, with per-target failures; `rounds` 0–3. |
| General capture | Navigate, read the initial window, then scroll 1,500 px and wait 800 ms before each further read. |

These are observed windows, not proof of full history or exhaustive search. `refresh:false` searches the local corpus. A new browser refresh starts from the source route; it does not resume a durable website pagination cursor. Query variants are caller supplied. Local embeddings rerank collected posts; they are not a global Threads semantic index.

Source inspected: `src/service.ts` (`capture`, `search`, `discover`, `profile`), `src/research.ts` (`research`), `src/server.ts`, `src/advanced-tools.ts`, and `src/direct-profile-types.ts`. The remote allowlist contains 15 names and excludes `threads_api_*` tools. Both provider modes use the selected browser session; the optional official API is a separate transport.

## Official API: documented contracts

Meta's current Markdown documentation was retrieved directly over HTTPS. The ordinary web reader could not access several pages; their `.md` representations returned readable documentation. Links below identify the primary sources actually inspected.

| Endpoint | Retrieval/pagination | Authentication and limits |
| --- | --- | --- |
| `GET /keyword_search` | Keyword/tag, `TOP`/`RECENT`, media type, exact author and `since`/`until` filters. Default 25, maximum 100 results per request. Neither the guide nor reference documents `after`/`before`; examples contain no paging contract. | `threads_basic` + `threads_keyword_search`. Without approval, only the authenticated user's own posts are searched; after approval, public posts are searchable. Maximum 2,200 queries per user across apps per rolling 24 hours; repeated queries count, zero-result queries do not. |
| `GET /{user-id}/threads` | Explicitly paginated authored-post list. | `threads_basic`; this edge is limited to the app-scoped user, not an arbitrary public username. |
| `GET /profile_posts?username=...` | Explicitly paginated public-profile post list. | `threads_basic` + `threads_profile_discovery`. Public profile must have at least 100 followers. Standard access only reaches some official Meta accounts. Maximum 1,000 requests per user per rolling 24 hours. |
| `GET /{media-id}/replies` | Paginated immediate/top-level replies. | `threads_basic` + `threads_read_replies`; the reply API overview describes replies to users' own posts. Arbitrary third-party conversation access is not established here. |
| `GET /{media-id}/conversation` | Paginated flattened top-level and nested replies. | Same reply permission boundary. `after` and `before` are mutually exclusive. |
| `GET /{media-id}` | Single media object; requires an official numeric media ID. | `threads_basic` without advanced access only retrieves Threads testers' posts; advanced access allows other users' public posts. |
| `GET /profile_lookup?username=...` | Exact username lookup, not fuzzy profile search. | Same profile-discovery permission, public-profile threshold and documented quota as above. |

Maximum 100 results does **not** mean a search is complete. Time-window subdivision can broaden a bounded sample, but is not a documented exhaustive cursor traversal. Ranking, visibility, permission and sensitive-keyword filtering still apply.

Primary sources:

- [Keyword and topic tag search](https://developers.facebook.com/documentation/threads/keyword-search.md)
- [Media retrieval reference](https://developers.facebook.com/documentation/threads/reference/media-retrieval.md)
- [Retrieve user and public-profile posts](https://developers.facebook.com/documentation/threads/retrieve-and-discover-posts/retrieve-posts.md)
- [Reply API scope and permissions](https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies.md)
- [Replies versus conversations](https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/replies-and-conversations.md)
- [Reply pagination reference](https://developers.facebook.com/documentation/threads/reference/reply-management.md)
- [Profile lookup](https://developers.facebook.com/documentation/threads/threads-profiles.md)
- [OAuth authorization and access tokens](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions.md)

The official route requires a Threads app, user authorization/token and the applicable approved permissions. A website login session is not an official API access token. No authenticated official API request was made in this research, so available official scopes and account-specific behavior remain unverified.

## Current official module and known contract gap

`src/official-api.ts` already supports fixed-host GET operations for search, own posts, public-profile posts, replies and conversations. Each call returns one API response. It uses a bearer header, blocks redirects, sanitizes credentials, and strips raw `paging.next`/`previous` URLs while retaining cursors.

It does not yet provide an automatic page collector, normalize API records into the local `Post` model, or route the existing remote tools to this transport. `ReadSource` currently has no official-API source value.

**Known, non-blocking research finding:** the shared input schema currently permits `after`/`before` for `search`, and an offline test in `tests/official-api.test.ts` asserts that `after` is sent. That mock proves request construction, not Meta support for search pagination. Current official search documentation does not establish that cursor contract. This was not fixed in this research and does not block the existing browser-read deliverable. If official integration is selected, validate parameters per operation instead of assuming all read endpoints share pagination.

Other integration details: do not assume browser internal IDs are official API IDs; retain official IDs and permalink/shortcode provenance. Keep missing counts null. API `has_replies:true` is a boolean, not a numeric reply count; current research expansion uses observed reply counts, so normalization must not invent a count to trigger expansion.

## Anonymous public HTML probe

One read-only request to [the public search page](https://www.threads.com/search?q=Threads%20API&serp_type=default), using an ordinary Mozilla user agent and no Cookie header or authenticated session, returned HTTP 200 with embedded JSON and post-shaped objects. The inspected pagination metadata reported `has_next_page:false` with no `end_cursor`.

This is a meaningful negative result for the proposed anonymous pagination route: the response supplied an initial sample but no observed next-page mechanism. It does not prove every anonymous query behaves identically, and post-shaped objects were not treated as unique verified posts. No page content or identities are reproduced here. No deeper anonymous pagination was established.

## Selected-browser-session direct requests

A same-origin request inside the explicitly selected tab can, in principle, let the browser attach its existing credentials without reading or exporting Cookie values. Chrome content scripts operate on behalf of the page origin and remain subject to same-origin rules. The current runtime uses an isolated world, which cannot directly read page JavaScript variables.

At the time of the isolated prototype, the extension exposed no production direct-fetch command. The prototype established a current read query, its schema, target binding and real continuation cursor. The subsequent v0.5.0 integration exposes only the scoped profile operation described above, not a general GraphQL interface. Neither stage establishes support for all website read operations. Do not guess document IDs or interpret all HTTP POST requests as reads.

The adapter boundary is named, verified read operations and fixed endpoints; session/request credentials stay inside the browser, returned data is structured, and context changes must invalidate continuation. Do not expose arbitrary URLs, headers, scripts or GraphQL operations through the remote tools. Website challenges or unsupported contracts should stop the direct path rather than trigger bypass attempts.

- [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome content-script isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Browser Fetch credentials semantics](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)

## Historical prototype: selected-tab second-page experiment, 2026-11-06

The experiment ran inside the already paired, signed-in Chrome tab using a temporary isolated-world runtime wrapper. It navigated to the viewer's public profile and an official public profile. Embedded profile data supplied an exact username/numeric-ID binding, a public-profile flag, initial edges, `has_next_page:true`, an end cursor, and current query variables. Credentials and cursor values stayed inside the tab; reports contain counts and booleans rather than raw responses or session values.

Current website static modules identified `BarcelonaProfileThreadsTabRefetchableDirectQuery` as `operationKind:"query"`, with the `mediaData` profile connection, pagination arguments and provided variables. The current persisted operation differed from the older competitor implementation. The website's network selection and server-URL modules established same-origin `/graphql/query`; this was not an arbitrary remote URL.

An initial request lacking the website's CSRF/App headers returned 403 for each target. Those failures were retained. After inspecting the current website network module, the prototype used its observed CSRF/App header contract with values kept inside the browser. Each corrected request returned 200. No challenge was solved or bypassed, no Cookie API was called, and no Cookie values were extracted or transferred. The change establishes a successful request construction; it does not isolate which missing header caused the earlier rejection.

| Target | Initial connection edges | Second-page edges | New target-authored posts | Cursor advanced | Scroll calls |
| --- | ---: | ---: | ---: | --- | ---: |
| Viewer public profile | 4 | 5 | 5 | Yes | 0 |
| Official public profile | 4 | 5 | 5 | Yes | 0 |

Each response's first post per connection edge matched the requested author. Both responses still reported a next page, so neither result proves complete history. A final read confirmed restoration of the ordinary runtime and the original route. No prototype source, raw response or credential artifact was published. There were no social writes or private-message reads.

**What this proved at the time:** the selected Chrome login retrieved a genuine second page of public profile posts without scrolling. **What it did not prove:** production Grok access to this path, long traversals, search/reply/follower pagination, resilience across website releases, or exhaustive results. This historical prototype is not acceptance evidence for the subsequent v0.5.0 deployed tool.

## Integration decisions and remaining research

1. The activated v0.5.0 implementation keeps the same 15 tool names and adds an explicit provider on `threads_get_profile`, retaining browser behavior by default.
2. Reuse the existing official transport for documented paginated edges. Add a bounded collector with page/record/time budgets, ID deduplication, cursor-loop detection, and explicit stop reasons for errors, limits and lack of progress.
3. Preserve safe continuation evidence before stripping raw paging URLs. An `after` cursor alone does not prove a next page exists; terminal status still does not prove global completeness.
4. Treat official keyword search as bounded query/time-window sampling until a real documented continuation contract is available. Keep provenance and ranking method visible.
5. The selected Chrome-session integration is limited to public profile posts with bounded continuation and explicit provider selection. Finish deployed/live acceptance before claiming Grok multi-page support is active. Do not expose arbitrary fetch, headers or GraphQL inputs.

Chrome-session research progressed from the narrow historical experiment to activated v0.5.0 production multi-page acceptance. No official API account capability was verified. The existing autonomous browser reads remain available through the default provider.
