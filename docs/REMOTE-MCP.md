# Reliable remote MCP: read-only and controlled writes

Use a **Cloudflare remotely managed tunnel with a fixed hostname** for Grok Bot. Quick Tunnel is only for temporary debugging. The endpoint uses authenticated, stateless Streamable HTTP with JSON responses; cookies stay in the owner's Chrome.

**Never publish port 19758.** It is the local extension pairing host, not a remote MCP endpoint. Tunnel only `http://127.0.0.1:19759`. A hostname or tunnel does not replace bearer authentication.

## Scope and recovery boundaries

The default read-only mode exposes exactly 15 remote tools: `threads_status`, `threads_search`, `threads_research`, `threads_my_activity`, `threads_find_mentions`, `threads_get_post`, `threads_get_post_activity`, `threads_get_replies`, `threads_get_profile`, `threads_get_connections`, `threads_check_relationship`, `threads_search_users`, `threads_discover`, `threads_reply_inbox`, `threads_batch_read`.

In default read-only mode, no messages, notifications, arbitrary browser controls, social writes, media uploads, official API, drafts, schedules or filesystem export tools are registered. Writes stay disabled even if `THREADS_ALLOW_WRITES=true` is inherited. Explicit controlled mode adds only the three named tools described below; it uses the separate `THREADS_REMOTE_ALLOW_WRITES` setting. Observations use the separate `remote-index` directory. Allowed reads include liked/saved posts and personal activity; give access only to a trusted client. Results are bounded observations, not complete history.

### Direct public-profile pagination (v0.5.0)

**v0.5.0 is activated and the deployed tool passed multi-page acceptance on 2026-11-06.** Loopback HTTP, public HTTPS and the actual `mcp-remote@0.16.1` header-file wrapper each returned four public-profile pages (19 unique posts), then three viewer-profile pages (14 unique posts). Later pages each added five target-authored posts with advancing cursors. The remote allowlist remains 15 tools and writes stay disabled. Wrapper testing ran on the maintainer's host; refresh/restart the owner's Grok MCP to load the new schema and verify its next read there.

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

The default remains 15 read tools. Enabling `THREADS_REMOTE_ALLOW_WRITES=true` for `serve-http` adds exactly three existing named capabilities: `threads_inspect_social`, `threads_prepare_social`, and `threads_execute_social`, for 18 tools total. `THREADS_ALLOW_WRITES` alone cannot enable remote writes. The selected extension/runtime v0.5.0 already supports these named actions; no extension update is required for this host-only change.

```powershell
# Apply when starting/restarting the HTTP host, with the existing bridge left running.
$env:THREADS_REMOTE_ALLOW_WRITES = 'true'
node dist/cli.js serve-http
```

To disable, stop only that HTTP host and restart it with the variable removed or set to `false`. A supervisor installation uses the explicit `remoteWritesEnabled` config instead; see [Windows setup](WINDOWS-REMOTE-HOST.md). Do not start duplicate listeners. Restarting HTTP invalidates preparations but preserves the existing bearer and bridge pairing.

The same bearer now grants access to the enabled tools. Supported kinds are `publish`, `reply`, `quote` (text only, up to 500 characters), `like`, `unlike`, `save`, `unsave`, `repost`, `unrepost`, `follow`, and `unfollow`. Deletion, private messages, media upload/local file access, schedules, official API and arbitrary UI controls remain unavailable.

Both inspect and prepare require `expectedAccount`, `kind` and `targetUrl`; text is accepted only for publication/reply/quote. Publishing uses `https://www.threads.com/`, follow operations use the exact profile URL, and post operations use the full author/post permalink. The controller checks the account and absence of drafts/dialogs before optional target navigation, checks again before staging, and preserves existing draft content. Resolve a blocked composer locally rather than overwriting it.

Prepare may open a menu/composer and fill an empty draft, but never submits. Review the returned `id`, exact account/request and 90-second expiry. Execute takes only `id` and `expectedAccount`; it cannot replace the reviewed text or target. IDs survive separate HTTP requests but are consumed once, including mismatch/expiry/cooldown/uncertain execution failures. Real dispatches share an 8-second cooldown. Context/manual changes invalidate the browser preparation; bearer rotation/revocation invalidates host preparations and access is rechecked before dispatch. An already dispatched effect cannot be undone by later revocation.

Enabling capabilities is not authorization to publish or interact. Execute only an effect the user specifically authorized. On `outcome-uncertain`, inspect and reconcile; never replay the execute call. A new prepare must reflect renewed specific intent, not automatic retry logic. No-op acceptance is not proof of live publication capability for every future UI state.
