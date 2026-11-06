# Controlled remote Threads MCP

Use a **Cloudflare remotely managed tunnel with a fixed hostname** for Grok Bot. Quick Tunnel is only for temporary debugging. The endpoint uses authenticated, stateless Streamable HTTP with JSON responses; cookies stay in the owner's Chrome.

**Never publish port 19758.** It is the local extension pairing host, not a remote MCP endpoint. Tunnel only `http://127.0.0.1:19759`. A hostname or tunnel does not replace bearer authentication.

## Scope and recovery boundaries

The default read-only mode exposes exactly 15 remote tools: `threads_status`, `threads_search`, `threads_research`, `threads_my_activity`, `threads_find_mentions`, `threads_get_post`, `threads_get_post_activity`, `threads_get_replies`, `threads_get_profile`, `threads_get_connections`, `threads_check_relationship`, `threads_search_users`, `threads_discover`, `threads_reply_inbox`, `threads_batch_read`.

In default read-only mode, no messages, notifications, arbitrary browser controls, social writes, media uploads, official API, drafts, schedules or filesystem export tools are registered. Writes stay disabled even if `THREADS_ALLOW_WRITES=true` is inherited. Explicit controlled mode adds three named social tools using `THREADS_REMOTE_ALLOW_WRITES`. A second, narrower `THREADS_REMOTE_ALLOW_MEDIA` opt-in adds one byte-upload tool; see the media contract below. Observations use the separate `remote-index` directory. Allowed reads include liked/saved posts and personal activity; give access only to a trusted client. Results are bounded observations, not complete history.

## Capability matrix (v0.7.0)

All flags default to `false`. Existing deployments retain 15 tools by default, 18 with writes, and 19 with writes + media. Additional groups are additive; the full surface has **44 remote tools**. `threads_status.tools` is the authoritative list, and both status and `/healthz` return the six capability booleans below. A capability is permission to use its controlled workflow, not authorization for a particular account effect.

| Environment flag | Prerequisite | Added tools | Total with only this group plus prerequisites |
|---|---|---:|---:|
| `THREADS_REMOTE_ALLOW_WRITES` | none | 3: inspect/prepare/execute social | 18 |
| `THREADS_REMOTE_ALLOW_MEDIA` | writes | 1: stage media remote | 19 |
| `THREADS_REMOTE_ALLOW_EXTENDED_READS` | none | 5: notifications, feed, collect, trends, observed analytics | 20 |
| `THREADS_REMOTE_ALLOW_DELETE` | writes | 2: prepare/execute confirmation; also adds social `kind=delete` | 20 |
| `THREADS_REMOTE_ALLOW_SCHEDULE` | writes | 9: draft/schedule family | 27 |
| `THREADS_REMOTE_ALLOW_BROWSER_FALLBACK` | writes | 4: snapshot, scroll, prepare/execute action | 22 |
| `THREADS_REMOTE_ALLOW_MESSAGES` | none | 1: get messages | 16 |
| `THREADS_REMOTE_ALLOW_OFFICIAL_API` | writes and host API configuration for actual requests | 4: API status/read/prepare/execute | 22 |

The matching capability keys are `extendedReads`, `delete`, `schedule`, `browserFallback`, `messages`, `officialApi`. The top-level `writesEnabled` and `mediaEnabled` retain their meanings. Extended reads use an additional explicit flag so the original 15/18/19 configurations do not silently gain notification-read effects or extra tools.

Exact additions to the original 19-tool media mode:

- Extended reads: `threads_get_notifications`, `threads_get_feed`, `threads_collect`, `threads_trends`, `threads_observed_analytics`.
- Delete: `threads_prepare_confirmation`, `threads_execute_confirmation`.
- Workflows: `threads_save_draft`, `threads_list_drafts`, `threads_delete_draft`, `threads_stage_schedule`, `threads_list_schedules`, `threads_authorize_schedule`, `threads_cancel_schedule`, `threads_run_schedules`, `threads_reconcile_schedule`.
- Browser fallback: `threads_browser_snapshot`, `threads_browser_scroll`, `threads_prepare_action`, `threads_execute_action`.
- Messages: `threads_get_messages`. When both extended reads and messages are enabled, `threads_get_feed(kind="messages")` uses the same guarded reader.
- Official API: `threads_api_status`, `threads_api_read`, `threads_api_prepare`, `threads_api_execute`.

The full 44-tool count equals the local count, but the surfaces differ. HTTP deliberately omits `threads_read_page`, local-path `threads_stage_media`, `threads_export` and browser `threads_account_insights`. Remote replacements are byte upload, guarded messages and two explicit deletion-confirmation tools. Account insights remain available through the optional API when its permissions permit. No arbitrary JavaScript, shell, filesystem read, raw DOM click, settings or private-message send tool is registered.

### Choose and deploy a mode

For regular use, enable the needed groups. A broad **39-tool** configuration enables everything below except messages and official API. The following **44-tool** example explicitly enables both sensitive options for a trusted client; do not treat it as permission to test real mutations.

**Privacy warning:** messages reads can reveal any content rendered on the messages route and may mark messages seen. Notifications may also update read state. Neither private view is indexed in the remote search database. Official API uses separate host-owned credentials and permissions; Chrome login does not configure it.

```powershell
$env:THREADS_REMOTE_ALLOW_WRITES = 'true'
$env:THREADS_REMOTE_ALLOW_MEDIA = 'true'
$env:THREADS_REMOTE_ALLOW_EXTENDED_READS = 'true'
$env:THREADS_REMOTE_ALLOW_DELETE = 'true'
$env:THREADS_REMOTE_ALLOW_SCHEDULE = 'true'
$env:THREADS_REMOTE_ALLOW_BROWSER_FALLBACK = 'true'
$env:THREADS_REMOTE_ALLOW_MESSAGES = 'true'      # Private visible content; may mark seen
$env:THREADS_REMOTE_ALLOW_OFFICIAL_API = 'true'  # Existing host API configuration only
node dist/cli.js serve-http
```

For this v0.7.0 upgrade, restart the owned bridge and HTTP processes for the new native command allowlist, preserving the tunnel. For later flag-only changes, restart only the HTTP process. For supervised hosts, edit the matching `remote*Enabled` booleans in the private config and use Stop → validate → Start; see [Windows host](WINDOWS-REMOTE-HOST.md). Never put token values into these examples or configuration JSON. When API credentials are absent, HTTP still starts and `threads_api_status` reports unconfigured; API requests fail closed. The supervisor forwards existing API environment configuration only to an explicitly enabled HTTP child.

Upgrade the host and extension together to v0.7.0, reload the unpacked extension and reconnect the selected tab. The local bridge must also restart for the new command allowlist; use its newly issued pairing code locally. Keep the remote bearer and tunnel URL unchanged unless intentionally rotating them. Refresh Grok's existing command MCP schema; no URL or header-file change is required for an unchanged endpoint. Loaded versions and actual reads must be checked before claiming activation. Updating files alone does not replace an existing process.

### Controlled behavior and limits

Deletion uses `prepare_social(kind="delete")` → review → `execute_social`. A `confirmation-required` response stops there. Obtain a **separate explicit final-delete authorization**, call `prepare_confirmation(sourceId,expectedAccount,purpose)`, review its new ID, and call `execute_confirmation` once. Final deletion remains `outcome-uncertain`; disappearance alone is not proof. Unsupported dialogs fail closed. The generic fallback cannot confirm deletion.

The browser fallback exposes only vetted public links and search navigation. Snapshot observes the current page; it accepts no URL. `click` means an approved link destination, and `fill` means an approved public search query. Consume validates account, source route, reference, draft and trusted manual-interaction state, then dispatches the fixed navigation in the same runtime turn. The response is `navigation-unverified`; a separate snapshot observes the destination. No DOM button click, text-entry event, message send or settings change occurs. Lost receipts remain single-use and must not be replayed.

Notifications/feed/messages require `expectedAccount`, explicit `purpose` and 0–3 additional read windows. A short-lived source binding is rechecked in the page immediately before the one navigation. Unknown values stay unknown, and windows remain partial. Message conversation clicks/sends are unsupported; visible split-pane content may be included if Threads already renders it.

Remote workflows use immutable account-bound drafts and separate stage → authorize → run calls. Browser publishing uses the existing social preparation/commit controller; no API credentials are needed. Run is explicit, at most 3 jobs and 20 remaining parts, with no timer or punctuality guarantee. Host, Chrome and the client runner must remain available. The remote database is separate from local stdio workflows; `schedule-worker` does not automatically pick up these remote jobs. Cancellation is the one authenticated MCP exception to the busy lock: only the exact active account/job can set its stop flag. A cancelled job cannot send an effect still waiting in native preflight; already dispatched outcomes are preserved.

Media drafts accept only an existing remote `mediaToken`, not a local path or download URL. Its ten-minute, same-composer, account/kind/target approval is not extended by scheduling, so long-term media scheduling is not supported. A later chain part cannot prebind media to an unknown parent. Confirmed parts never replay; uncertainty halts the chain. Root text outcomes can be reconciled against a fresh exact own post. Media/reply/quote relationships cannot be promoted to confirmed by free-text evidence. Browser alt text remains explicitly unsupported; official API image/video containers accept `alt_text` under the separate API gate. See [workflows](WORKFLOWS.md) and [social actions](SOCIAL-ACTIONS.md).

API preparation/execute require the configured numeric `expectedAccount` and an explicit purpose at preparation. Credentials never come from tool arguments. API delete additionally requires the DELETE flag. Revocation is checked before every API network dispatch; unknown mutation outcomes are consumed, not retried. Browser delete confirmation and API deletion are separate contracts: a reviewed API delete is itself the explicit final deletion authorization.

### Manual live acceptance checklist

Offline and isolated fixtures verify these contracts without changing a real account. For an installation:

1. Check anonymous HTTPS returns 401; inspect authenticated status/health, flags and exact tool list.
2. Confirm loaded host/extension/runtime versions, then perform two ordinary expected-account profile reads. Verify partial provenance and the next read cycle.
3. Refresh Grok's existing command MCP and repeat schema/status plus a safe read from Grok. Host-side proxy tests are not proof of a Grok-owned run.
4. Do not read messages/notifications solely as a connection test. Exercise them only when the user specifically requests that view and accepts read-state effects.
5. Test a social action, media upload, deletion or scheduled publication only against specifically authorized real content. Review every prepared ID. For deletion stop at the first confirmation and request separate final intent.
6. For uncertain results retain the ID/evidence, inspect actual state, and never automatically resend. Test cancellation/revoke/restart safety with offline fixtures, not repeated live publications.

### Direct public-profile pagination (v0.5.0)

**v0.5.0 is activated and the deployed tool passed multi-page acceptance on 2026-11-06.** Loopback HTTP, public HTTPS and the actual `mcp-remote@0.16.1` header-file wrapper each returned four public-profile pages (19 unique posts), then three viewer-profile pages (14 unique posts). Later pages each added five target-authored posts with advancing cursors. That dated acceptance used the default 15-tool read-only mode. Wrapper testing ran on the maintainer's host; refresh/restart the owner's Grok MCP to load the new schema and verify its next read there.

```json
{"tool":"threads_get_profile","arguments":{"username":"target_handle","section":"posts","provider":"direct","maxPages":4,"pageSize":5}}
```

| Parameter | Contract |
| --- | --- |
| `provider` | `browser` by default; `direct` opts into selected-Chrome-session requests. |
| `section` | Direct mode supports `posts` on public profiles only. Other sections retain the browser provider. |
| `maxPages` | Integer 1–5, default 3; includes the initial bootstrap page. |
| `pageSize` | Integer 1–20, default 10; requested continuation-page size, not a guarantee about the bootstrap window or total results. |
| `rounds` | Used by the browser provider; ignored by direct mode. |

One direct call navigates to the target profile and collects a bounded sequence without scrolling. It never silently falls back to scrolling. A new call starts from the profile again; there is no cross-call resume. Authentication remains in the selected Chrome tab, with request credentials kept inside the page; no Cookie transfer or official API token is required. This is a scoped profile-read operation, not an arbitrary fetch or GraphQL tool.

The response retains `completeness:"partial"` and adds `pagination` containing `provider`, `pagesFetched`, `requests`, `uniquePosts`, `hasNext`, `stopReason`, and `pages`. Each page records `page`, `received`, `added`, and `cursorAdvanced`. `requests` counts direct continuation attempts; `pagesFetched` counts collected pages including bootstrap. Later-page positive `added` values, together with cursor progress, are the evidence of productive pagination.

Inspect `stopReason` and warnings: `page_limit` is budget exhaustion, `end_of_connection` is an observed endpoint, and `no_progress`, cursor, schema or request failures are stopping conditions. None establishes complete history. Keep `hasNext:null` as unknown. Do not replay repeated calls as if they continued a prior cursor.

Production acceptance exercised this exact tool through the deployed connection, observed later-page additions, and confirmed the subsequent read with writes disabled. Both results stopped at `page_limit` with `hasNext:true`; neither was complete history. The [Grok prompt](GROK-BOT.md#v050-direct-multi-page-public-profile-reads) provides the call and reporting instructions. The [dated record](DIRECT-READ-RESEARCH.md) separates the earlier prototype from production acceptance.

Recovery restarts services and prepares the next read. It **does not replay a failed browser command**, reconnect a manually disconnected tab, log in to Threads, or solve a challenge. Chrome's session-only pairing and a new bridge token require user pairing after either restarts. HTTP remains available while bridge is absent and adopts fresh local pairing information before a subsequent command; no HTTP restart is needed just because bridge restarted.

## 1. Configure the permanent route once

Prerequisites: Node.js 24+, Chrome with the unpacked extension, cloudflared 2025.4.0+ (`--token-file` support), and a domain in your Cloudflare account. Build with `npm ci` and `npm run build`.

Create a remotely managed Cloudflare Tunnel and add a published application route. Keep the same tunnel and hostname when restarting its connector:

| Setting | Value |
|---|---|
| Public hostname | A dedicated hostname, for example `threads-mcp.example.com` |
| Origin service | `http://127.0.0.1:19759` |
| Origin HTTP Host Header | `127.0.0.1:19759` |
| Path | Leave empty to preserve `/mcp` and `/healthz` |

Set **HTTP Host Header in the route's origin settings**. Quick Tunnel's command-line `--http-host-header` is not a substitute for this on managed ingress routes. A wrong value yields 403. Keep public TLS verification enabled. Do not place an interactive login/email challenge in front of a machine client unless it has a separately supported authentication setup.

Save only the connector token (not the full Cloudflare installation command) in the private file configured by the Windows helper. Use a local editor/secure input; never put its value in commands, chat or logs. Connector token and MCP bearer are different secrets. This project does not create DNS or request Cloudflare credentials automatically.

References: [managed tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), [origin Host header](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/), [token-file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).

## 2. Windows login startup and supervision

Use [Windows remote host commands](WINDOWS-REMOTE-HOST.md) to initialize, install, start, inspect and stop the host. One limited task starts at the current interactive user's **login**, not before login. No administrator password is stored. The supervisor starts bridge, HTTP and managed tunnel, checks their ports/health and restarts its own exited children with backoff. It never adopts or kills unrelated processes occupying these ports.

After logging into Windows:

1. The scheduled supervisor starts services. Open Chrome and the dedicated signed-in Threads tab.
2. Open `http://127.0.0.1:19758/`, copy the current pairing code into the extension popup and click **連接此分頁**. Never give this code to Grok.
3. Run the local status command. Confirm HTTP responds, bridge is connected and tunnel readiness succeeds.
4. In Grok, call `threads_status`, then `threads_my_activity` with the expected account and `threads_get_profile` for a second read. Only these actual reads establish account access.

Keep the machine awake, online and logged in. Locking the desktop differs from logging out/sleeping. Scripts do not change power policy or automatically start/recover Chrome. Repeat pairing after browser/bridge restarts. Explicit supervisor Stop persists until explicit Start; it is not treated as a crash to undo.

## 3. Grok Bot command MCP

Use the **command wrapper with mcp-remote --header-file**, not a literal secret-request reference inside AddMcpServer headers. The owner verified this command route in Grok Bot on 2026-11-06. Direct header injection was rejected or remained literal in that environment. This is an observed integration constraint, not a claim that every Grok API client lacks header support.

[GROK-BOT.md](GROK-BOT.md) supplies a pinned command example, secure header-file instructions and acceptance prompt. Register `https://YOUR-HOSTNAME/mcp`.

To migrate from Quick Tunnel: verify the managed URL, update the existing Grok command's URL argument, restart that MCP process, then perform two real reads. Disable the old registration so two clients do not drive the tab. Stop only your old Quick Tunnel process. Hostname migration does not require changing bearer, pairing code or cookies.

## 4. Diagnose by layer

`threads_status` returns fresh connection health without reading a page. Authenticated `GET /healthz` supplies the same bounded health plus HTTP busy state. During a long request it returns cached bridge state with its original `checkedAt`; it does not interrupt that request. Both outputs omit credentials, local paths and tab titles/URLs. Health checking adds no MCP tool; controlled-write mode separately adds three named social tools.

| Evidence | Meaning and next step |
|---|---|
| Local 19759 does not listen | HTTP is down or failed to bind. Inspect supervisor state/log; resolve port collision without killing its owner. |
| HTTP responds; `pairing-missing` or `host-unreachable` | Check local 19758 and bridge process. Missing pairing file alone does not prove process absence. Wait for recovery and pair the tab if needed. |
| `extension-disconnected` | Bridge is alive without an authenticated tab. Open signed-in Chrome and pair. No HTTP/tunnel restart needed. |
| `auth-failed` / `pairing-invalid` | Check data directory/port and running bridge's local pairing page. Never paste pairing data into chat. |
| `connected` | Extension transport is connected; login/UI still needs a real read. |
| Local HTTP works, tunnel /ready fails or connector exited | Tunnel/edge/network unavailable. Supervisor restarts an exited connector; a live connector can reconnect itself. |
| Tunnel ready but public URL fails | Check DNS, route, Host header, Access policy or edge/network. /ready is not end-to-end proof. |
| Public 401 | HTTP path reached, bearer missing/wrong. Update Grok's private header file and restart wrapper. |
| Public 403 | Check origin Host header and Cloudflare Access. Do not disable server checks. |
| 503 Access disabled | Bearer revoked, missing, unreadable or invalid. Restore only with intentional rotation. |
| Public 429 | Another read is running. Honor Retry-After and avoid concurrent controllers. |

An unreachable MCP cannot diagnose its own HTTP/tunnel outage from inside that failed connection. The **local status script** reports process ownership, ports, HTTP identity, bridge state, tunnel readiness and an optional anonymous public check. A listening port alone does not prove success.

Short text for Grok:

> Threads MCP is unreachable. Please confirm your Windows PC is awake and logged in, then run the local RemoteHost status command. If HTTP is down, inspect the supervisor; if tunnel is down, check cloudflared/network; if bridge says extension-disconnected, open the dedicated signed-in Threads tab and pair at http://127.0.0.1:19758/. For 401, update my private header file through secure input and restart this MCP. Do not send cookies, tokens or raw logs in chat. After recovery I will verify the expected account with two reads.

## 5. Verify without social writes

```powershell
npm run test:http
$env:THREADS_REMOTE_URL = 'https://threads-mcp.example.com/mcp'
npm run test:http
# Optional: explicitly perform two real account reads.
$env:THREADS_HTTP_LIVE = 'true'
npm run test:http
Remove-Item Env:THREADS_HTTP_LIVE,Env:THREADS_REMOTE_URL
```

Checks cover 15 tools, anonymous 401, disabled writes, absent write tools, /healthz and local search. A count-only report stays in the private data directory. Set the host's `THREADS_DATA_DIR` if nondefault. Transport success is separate from real account-read acceptance.

## 6. Rotate or revoke bearer

```powershell
# Revocation persists across automatic restarts:
node dist/cli.js remote-token revoke
# Intentionally create a replacement; never printed:
node dist/cli.js remote-token rotate
```

The file is `remote-access.token` under `THREADS_DATA_DIR` or `.threads-data`. Once the upgraded host initializes `remote-access.initialized`, deleting only the token also revokes across restarts. Keep the marker; use explicit rotate to recover. Legacy installations without the marker should use `remote-token revoke` for durable revocation. In-flight reads are not cancelled by revocation; stop HTTP/tunnel to interrupt access immediately.

Apply private Windows permissions after creating a replacement, transfer it through Grok's secure input into the header file, then restart that command MCP to reload headers. Old bearer requests fail. Bridge pairing and Cloudflare connector tokens are unchanged. Never print secrets for diagnosis.

## Temporary debugging only: Quick Tunnel

```text
cloudflared tunnel --url http://127.0.0.1:19759 --http-host-header 127.0.0.1:19759 --no-autoupdate
```

Use the printed HTTPS hostname plus /mcp. It changes on restart and has no uptime guarantee. The supervisor does not automatically create Quick Tunnels or change Grok URLs. [Cloudflare's limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) also exclude SSE; this server uses JSON responses. Manual debug hosts can still run `node dist/cli.js bridge` and `node dist/cli.js serve-http`; do not run duplicates alongside supervision.

## Controlled remote writes (v0.5.1, explicit opt-in)

The default remains 15 read tools. Enabling `THREADS_REMOTE_ALLOW_WRITES=true` for `serve-http` adds exactly three existing named capabilities: `threads_inspect_social`, `threads_prepare_social`, and `threads_execute_social`, for 18 tools total. `THREADS_ALLOW_WRITES` alone cannot enable remote writes. The v0.5.1 text-only change required no extension update. Media requires matching host and extension/runtime; current release is v0.7.0.

```powershell
# Apply when starting/restarting the HTTP host, with the existing bridge left running.
$env:THREADS_REMOTE_ALLOW_WRITES = 'true'
node dist/cli.js serve-http
```

To disable, stop only that HTTP host and restart it with the variable removed or set to `false`. A supervisor installation uses the explicit `remoteWritesEnabled` config instead; see [Windows setup](WINDOWS-REMOTE-HOST.md). Do not start duplicate listeners. Restarting HTTP invalidates preparations but preserves the existing bearer and bridge pairing.

The same bearer now grants access to the enabled tools. Supported kinds are `publish`, `reply`, `quote` (text only, up to 500 characters), `like`, `unlike`, `save`, `unsave`, `repost`, `unrepost`, `follow`, and `unfollow`. With only the writes flag enabled, deletion, private messages, schedules and official API remain unavailable. Additional flags are listed in the capability matrix; arbitrary UI controls and local file access stay excluded. Byte uploads require the separate media opt-in below.

Both inspect and prepare require `expectedAccount`, `kind` and `targetUrl`; text is accepted only for publication/reply/quote. Publishing uses `https://www.threads.com/`, follow operations use the exact profile URL, and post operations use the full author/post permalink. The controller checks the account and absence of drafts/dialogs before optional target navigation, checks again before staging, and preserves existing draft content. Resolve a blocked composer locally rather than overwriting it.

Prepare may open a menu/composer and fill an empty draft, but never submits. Review the returned `id`, exact account/request and 90-second expiry. Execute takes only `id` and `expectedAccount`; it cannot replace the reviewed text or target. IDs survive separate HTTP requests but are consumed once, including mismatch/expiry/cooldown/uncertain execution failures. Real dispatches share an 8-second cooldown. Context/manual changes invalidate the browser preparation; bearer rotation/revocation invalidates host preparations and access is rechecked before dispatch. An already dispatched effect cannot be undone by later revocation.

Enabling capabilities is not authorization to publish or interact. Execute only an effect the user specifically authorized. On `outcome-uncertain`, inspect and reconcile; never replay the execute call. A new prepare must reflect renewed specific intent, not automatic retry logic. No-op acceptance is not proof of live publication capability for every future UI state.

## Controlled remote media (v0.6.0)

This implementation chooses **client-supplied chunks**. It needs neither public media hosting nor an official API token. It accepts no download URL and no host filesystem path. Local-path `threads_stage_media` remains absent from HTTP. API tools appear only under their separate official-API flag. The existing bearer, pairing boundary and loopback-only ports are unchanged.

| Remote write flag | Remote media flag | Tools and behavior |
|---|---|---|
| false/unset | false/unset | 15 read tools |
| true | false/unset | 18 tools, named social operations only |
| true | true | 19 tools, adds `threads_stage_media_remote` |
| false/unset | true | Invalid configuration; HTTP refuses startup |

`THREADS_ALLOW_WRITES` alone enables neither remote capability. For a manual HTTP host, stop only that host and start the updated build with both flags:

```powershell
$env:THREADS_REMOTE_ALLOW_WRITES = 'true'
$env:THREADS_REMOTE_ALLOW_MEDIA = 'true'
node dist/cli.js serve-http
```

For the supervisor use `remoteWritesEnabled:true` and `remoteMediaEnabled:true` in its private configuration and follow [Stop → validate → Start](WINDOWS-REMOTE-HOST.md). Do not start a duplicate listener. Reload the unpacked **v0.7.0** extension and reconnect the selected tab locally after updating it. The host requires the runtime media capability marker before opening a composer. Restart/reconnect Grok's existing command MCP to refresh the schema; keep its HTTPS URL and private header file. Verify `writesEnabled:true`, `mediaEnabled:true` and 19 tools. Enabling media is authority to stage supported bytes, not permission to publish arbitrary content.

### One bounded upload tool

All operations require a client-generated `uploadId` UUID and exact `expectedAccount`. Generate and retain the ID **before** begin so a lost response can be inspected. Each row below is a separate sequential tool call, never a JSON-RPC batch.

| `operation` | Additional fields | Effect |
|---|---|---|
| `begin` | `kind` (`publish`, `reply`, `quote`), canonical `targetUrl`, `files` | Reserve one isolated upload. Files contain `name`, MIME `mime`, byte `size`, lowercase hex `sha256`. No browser action. |
| `chunk` | zero-based `fileIndex`, exact byte `offset`, canonical base64 `data` | Append at the acknowledged offset. Maximum 32,768 decoded bytes per request. Duplicate/out-of-order chunks fail. |
| `status` | none | Return durable status and each file's acknowledged `received` count. A current-process staged receipt also returns its `mediaToken`; it is cached receipt evidence, not a fresh claim that a composer or preview still exists. Does not repeat browser operations. |
| `finish` | none | Consume finish once, verify complete lengths, signatures and SHA-256, verify account/runtime/draft, navigate to the exact target, open one empty bound composer, and stage media. Never publishes. |
| `abort` | none | Discard pending bytes and invalidate this upload's approval. Does not clear an existing browser draft/attachment or undo an uncertain effect. |

Publishing targets `https://www.threads.com/`; reply/quote targets the exact post permalink. At most **20 files**, **8 MiB per image**, **64 MiB per video**, **64 MiB total**. Types match local staging: JPEG (`.jpg/.jpeg`), PNG, GIF, WebP, MP4/M4V, QuickTime MOV and WebM. MIME, extension and signature must agree. This checks format signatures, not complete codec validity; browser preview checks still apply. Alt text is unsupported and extra `altTexts`, `paths`, URL or arbitrary fields are rejected.

The host writes only generated filenames beneath its private `remote-index/remote-media` directory. Client names are display metadata, validated against separators, traversal, controls and reserved names. Windows applies a private ACL before receiving bytes; no permissions are broadened. POSIX uses private directory/file modes. One receiving/finishing upload is allowed per host. Uploads expire after **five minutes**, without sliding renewal; media approval lasts at most **ten minutes**. Bytes are removed after success, failure, abort, expiry, credential invalidation or restart recovery. Restart cleanup runs when media mode next initializes. Small terminal receipts remain to prevent replay: at 1,024 receipts, new uploads fail closed with `MEDIA_RECEIPT_LIMIT`. This version has no remote receipt-deletion tool; maintenance must preserve uncertain/consumed ID evidence.

### Recovery, review and health

After a chunk timeout, call `status`; resume only from returned offsets if still `receiving`. Repeating the same `begin` ID with the same manifest returns its existing status; it never starts a fresh transfer. A conflicting manifest is rejected. **Do not blindly repeat `finish`.** Finish is recorded before browser side effects. A lost successful response can be recovered with `status`; `finishing` means wait and inspect. `outcome-uncertain` requires inspecting the selected composer or resulting account/post before any new attempt. An `UPLOAD_NOT_FOUND` after migration/storage loss is unknown, not proof that the prior operation did not run. Reusing an old ID or creating a new upload to automatically repeat an uncertain action is forbidden.

HTTP restart expires incomplete uploads and prior media approvals; an interrupted finish becomes `outcome-uncertain`. Bearer rotation/revocation invalidates all live uploads, media approvals and prepared social IDs. Access is checked around asynchronous steps and before each browser dispatch. An effect already dispatched cannot be undone by later revocation. No browser finish or publication is automatically replayed.

Successful stage returns `mediaToken`, `published:false`, `previewReady:null`: file assignment occurred, but preview/processing readiness has not yet been established. Call `threads_prepare_social` with that token, the same account/kind/target, and the explicitly approved nonempty text (at most 500 characters). Preparation verifies exact attachment objects, visible previews and the empty editor before filling text. Review the returned request/account/ID/expiry, then call `threads_execute_social` with **only** `id` and `expectedAccount`; media is already bound and cannot be replaced at execution. The ID expires after 90 seconds and is consumed once. The current browser verifier intentionally cannot prove that platform-rendered attachments match the uploaded bytes. Even when it finds a new exact-caption post, media returns `publication-observed-media-unverified` and execution remains `outcome-uncertain`, with a candidate post URL when observed. A successful dispatch is not a verified publication result. Inspect actual posts and attachments before another action; never replay execute.

One MCP HTTP request remains active at a time, including chunks and the entire finish transfer. Other requests receive **429** (except exact authenticated active-schedule cancellation) with `Retry-After`; during finish, even `status` may be busy until the outstanding request ends. Authenticated `/healthz` remains available with `busy:true` and cached bridge state/its original `checkedAt`; it does not read the composer or prove upload progress. Between chunk calls, health may refresh transport status. Use `status` for acknowledged upload progress. Give a finish call an adequate client timeout (up to five minutes); a timeout never authorizes resending it.
