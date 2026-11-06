# Optional official Threads API adapter

`src/official-api.ts` adds an authenticated official API path alongside browser reads. It uses a fixed `https://graph.threads.com/v1.0/` origin, an Authorization bearer header, a bounded request timeout, no redirects, and no automatic retries. A connected browser account does not supply this adapter's credentials.

Configure `THREADS_API_ACCESS_TOKEN` in the server environment. Read calls can use `me`; writes additionally require the exact numeric `THREADS_API_USER_ID` and `THREADS_ALLOW_WRITES=true`. Never place a token in a tool argument, committed configuration, example output, or chat. Token generation, refresh, Meta app review and permission grants remain external setup requirements. Local `status()` reports configuration only; it does not assert authentication, granted permissions, or live write acceptance.

## Read coverage

`read(operation, input)` performs one bounded API request and returns `source: official_threads_api`, observation time, raw sanitized API data, and `completeness: api_page`. Paging URLs are omitted because they may carry credentials; cursor values remain available for the next explicitly requested page. A page is not a complete history. Missing engagement values remain missing/null.

| Operation | Official route | Boundary |
| --- | --- | --- |
| `own_profile` | `GET /me` | Actual token identity |
| `own_posts` | `GET /{user-id}/threads` | Authenticated account posts |
| `profile_lookup` | `GET /profile_lookup?username=...` | Exact public username discovery |
| `profile_posts` | `GET /profile_posts?username=...` | Public profile discovery access |
| `post` | `GET /{media-id}` | API-accessible media |
| `search` | `GET /keyword_search` | Keyword or tag, TOP or RECENT; optional media/author filter |
| `mentions` | `GET /{user-id}/mentions` | Public mentions accessible to the app |
| `replies`, `conversation` | `GET /{media-id}/replies`, `/conversation` | Top-level or flattened conversation page |
| `pending_replies` | `GET /{media-id}/pending_replies` | Pending/ignored replies to an authorized post |
| `post_insights` | `GET /{media-id}/insights` | Authorized own-post analytics |
| `user_insights` | `GET /{user-id}/threads_insights` | Own account analytics; demographic requests require breakdown |
| `container_status` | `GET /{container-id}?fields=id,status,error_message` | Safe processing-state inspection |
| `publishing_limit` | `GET /{user-id}/threads_publishing_limit` | API quota information |

The baseline permission is `threads_basic`. Publishing needs `threads_content_publish`; keyword search needs `threads_keyword_search`; discovery needs `threads_profile_discovery`; mentions needs `threads_manage_mentions`; insights needs `threads_manage_insights`; reply retrieval/moderation and deletion need their corresponding approved access. Permission errors are returned as failures, never as empty successful data. This adapter does not request OAuth scopes or infer a grant from a configured token.

Meta's current documentation limits public search without the approved permission to the authenticated user's own posts. Profile discovery has eligibility/access restrictions, including public targets with at least 100 followers and limited standard-access test profiles. Mentions and other capabilities also vary with app access level. Review the linked official documentation for current limits rather than treating the operation list as universal access.

## Prepared writes

Exported `officialActionSchema`, `officialContainerSchema`, and TypeScript types are the integration contract. `prepare(action)` validates and snapshots an exact action, reads `/me`, checks the configured numeric account ID, and returns a reviewable action with account username, random prepared ID, and expiry. `execute(preparedId)` consumes the in-memory preparation before asynchronous work, rechecks the account identity, and sends at most one mutation. Preparations expire after two minutes by default (maximum five minutes), do not survive a restart, and are capped at 100 pending entries. Mutating a returned review object does not alter the stored action.

Supported actions:

- `create_container`: TEXT, IMAGE, VIDEO, or CAROUSEL; optional `reply_to_id` or `quote_post_id`; creation-time reply control, reply approvals, topic tag and supported attachment metadata.
- `publish_container`: publish a specified creation ID only after a fresh status read reports `FINISHED`.
- `delete_post`: delete a specified API media ID.
- `hide_reply`: hide or unhide a specified top-level reply (`hide: true/false`). Meta applies this to nested replies together; this is not an independent nested-reply hide operation.
- `manage_pending_reply`: approve or ignore a specified pending reply (`approve: true/false`).

Create/status/publish are intentionally separate. A workflow first prepares and executes each IMAGE/VIDEO child with `is_carousel_item=true`, checks processing, then prepares a CAROUSEL container with 2–20 distinct child IDs and publishes that container. Image/video URLs must be HTTPS and accessible to Meta; this adapter does not upload local files or verify media bytes. The local text guard counts at most 500 Unicode code points; Meta performs the authoritative text and media validation.

Higher-level workflow orchestration must retain each returned container/media ID and the exact authorized draft, bound status polling by a deadline, and preserve partial progress. It must not automatically repeat a failed mutation. A network failure, server error or unconfirmed success response is `outcome: unknown`; inspect the account/container before any new preparation. Known preflight failures are `not_sent`, explicit API rejections are `rejected`, and a response with the expected media ID or `success:true` is `api_confirmed`. API confirmation is not a browser-verified public delivery assertion. No test should publish real content to validate this adapter.

Reply controls are supported at creation time. There is no claimed general edit-published-post endpoint here. Likes, saves, follows, messaging, notification inbox, follower enumeration and browser-only actions are not silently mapped to unsupported official endpoints. Polls, GIFs, spoilers, location tagging and cross-sharing are also outside this adapter's current action schema.

## Evidence and validation

Single-post reads request `owner`, `children`, `root_post`, `replied_to` and `quoted_post` in addition to text/media fields, as documented by the [media retrieval reference](https://developers.facebook.com/documentation/threads/reference/media-retrieval). Published media types use `TEXT_POST` and `CAROUSEL_ALBUM`; creation parameters use `TEXT` and `CAROUSEL`. Reply relationship examples return `{id: ...}` objects. Child details may require further explicit reads; missing relationships or attachments cannot establish successful publication of the intended draft.

The adapter has offline injected-transport tests for authentication absence, safe transport/response handling, discovery/reply/insight routes, write gating, identity mismatch, immutable prepared content, concurrent one-shot execution, expiry, uncertain writes, processing guards, carousel/reply parameters, moderation/deletion confirmations, and input rejection. No live token, app permission or write was verified during implementation.

Official documentation inspected on 2026-10-24 (Asia/Taipei): [posts and carousel creation](https://developers.facebook.com/documentation/threads/posts/), [reply controls and moderation](https://developers.facebook.com/documentation/threads/reply-management/), [keyword search](https://developers.facebook.com/documentation/threads/keyword-search/), [profile discovery](https://developers.facebook.com/documentation/threads/threads-profiles/), and [insights](https://developers.facebook.com/documentation/threads/insights/). Routes were also cross-checked against the current registered implementations in [mikusnuz/meta-mcp publishing](https://github.com/mikusnuz/meta-mcp/blob/main/src/tools/threads/publishing.ts), [replies](https://github.com/mikusnuz/meta-mcp/blob/main/src/tools/threads/replies.ts), and [media/discovery](https://github.com/mikusnuz/meta-mcp/blob/main/src/tools/threads/media.ts). Third-party code is corroboration, not a promise that an account has access.
