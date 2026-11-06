# Direct reads and autonomous exploration

Inspected: **2026-11-06**. This is a research record, not a deployment or live authenticated API acceptance report.

Scope: support autonomous multi-page exploration and investigate direct data pagination without driving page scrolling, while keeping the existing 15 remote read tool names, no social writes, and no Cookie transfer. No source implementation was changed for this research. The optional official API is currently unconfigured; no credentials were requested or used. The user selected research using the existing Chrome login; do not require a Meta developer token for that pilot. Direct session pagination remains unimplemented and unverified at this checkpoint.

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

Source inspected: `src/service.ts` (`capture`, `search`, `discover`), `src/research.ts` (`research`), `src/server.ts`, and `src/advanced-tools.ts`. The remote allowlist contains 15 names and excludes `threads_api_*` tools. Remote status currently describes browser-only reads.

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

The official route requires a Threads app, user authorization/token and the applicable approved permissions. A website login session is not an official API access token. No authenticated request was made in this research, so available scopes and account-specific behavior remain unverified.

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

This makes a scoped direct-read adapter plausible, not currently implemented or live verified. The existing extension exposes no direct fetch command. Before implementation, observe a current read operation, its request/response schema, target binding and real continuation cursor. Do not guess private GraphQL document IDs or interpret all HTTP POST requests as reads.

An eventual adapter should allow only named, verified read operations and fixed endpoints; keep session/request credentials inside the browser; return sanitized structured data; and invalidate continuation on selected-tab, document, account or source changes. Do not expose arbitrary URLs, headers, scripts or GraphQL operations through the remote tools. Website challenges or unsupported contracts should stop the direct path rather than trigger bypass attempts.

- [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome content-script isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Browser Fetch credentials semantics](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)

## Minimal integration proposal

1. Keep the same 15 tool names. Add an explicit optional provider only where supported, retaining browser behavior by default and reporting unavailable official configuration truthfully.
2. Reuse the existing official transport for documented paginated edges. Add a bounded collector with page/record/time budgets, ID deduplication, cursor-loop detection, and explicit stop reasons for errors, limits and lack of progress.
3. Preserve safe continuation evidence before stripping raw paging URLs. An `after` cursor alone does not prove a next page exists; terminal status still does not prove global completeness.
4. Treat official keyword search as bounded query/time-window sampling until a real documented continuation contract is available. Keep provenance and ranking method visible.
5. Add selected-session direct reads only after validating a specific two-page read path with advancing cursor and distinct results. This is a separate prerequisite from the already supported autonomous browser scrolling.

No provider was selected, no direct pagination adapter was implemented, and no official account capability was live verified as part of this research. Existing browser reliability and autonomous-read work can continue independently.
