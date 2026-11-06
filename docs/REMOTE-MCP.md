# Remote read-only MCP for Grok Bot

The `serve-http` command exposes a separate, authenticated MCP endpoint. Threads cookies stay in the owner's Chrome profile. The extension pairing host at port 19758 must remain local and must never be tunneled.

## Access scope

The endpoint exposes 15 explicitly selected structured read tools: status, search, research, own activity (including liked/saved), mentions, posts, replies, profiles, post likes/reposts, followers/following, relationship checks, profile search, discovery, reply inbox and batch reads. Opening these views navigates the selected tab. Results are partial observations, not complete account history.

No messages, notifications, arbitrary browser controls, social writes, media uploads, official API, drafts, schedules or filesystem export tools are registered. Writes stay disabled even if the surrounding environment sets `THREADS_ALLOW_WRITES=true`. Remote observations use a separate `remote-index` directory, not the existing local corpus. Discovery and status omit raw page/connection details.

Anyone holding the remote bearer token can read the allowed account data, including liked/saved posts and the account's replies. Use it only with a trusted client. It is a different secret from the extension pairing token. Do not put either token in chat, a URL, source code or logs.

## Start locally

Build first with `npm ci` and `npm run build`. Start the local bridge if it is not already running:

```text
node dist/cli.js bridge
```

Pair a dedicated Threads tab using the local page at `http://127.0.0.1:19758/`. Keep that tab out of other browser automation controllers. Then, in another terminal at the project root:

```text
node dist/cli.js serve-http
```

It binds only to `127.0.0.1:19759`. Override the port with `THREADS_HTTP_PORT`. It attaches to the existing local bridge and does not start, replace or expose that bridge. The remote token is generated once at `.threads-data/remote-access.token` (or `THREADS_DATA_DIR`). Restrict this private directory to your own OS account, especially on Windows where POSIX file modes do not configure ACLs.

## Temporary HTTPS URL

For an initial connection, a Cloudflare Quick Tunnel can forward **only the remote HTTP port**:

```text
cloudflared tunnel --url http://127.0.0.1:19759 --http-host-header 127.0.0.1:19759 --no-autoupdate
```

The MCP URL is the generated HTTPS hostname plus `/mcp`. This implementation uses stateless Streamable HTTP with JSON responses, without SSE. The tunnel hostname is not a password: every request still needs `Authorization: Bearer <remote token>`. Browser-origin requests are rejected; this is a machine-client endpoint.

Quick Tunnels have no uptime guarantee, change hostnames on restart, and stop when cloudflared stops. Use a managed tunnel and a hostname you control for a durable service. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Connect Grok Bot

Ask Grok Bot to add a remote MCP by URL with bearer authentication. Enter the remote token through its secure secret form, not ordinary chat. If it requests an Authorization header, supply `Bearer ` followed by the token; if it explicitly requests only the bearer token, supply just the token. Do not use the extension pairing token.

[Grok Bot supports URL and command MCP servers](https://docs.x.ai/grok-bot/computer-and-apps). For API clients, the [xAI remote MCP guide](https://docs.x.ai/developers/tools/remote-mcp) documents `server_url` and authentication headers. The API support is separate from successful configuration of a particular Grok Bot account.

After connecting, require actual acceptance: list 15 tools, confirm writes are disabled, read own posts with `threads_my_activity`, confirm the expected account, then read that profile again. Merely seeing the tool list does not prove browser connectivity.

## Verify, revoke and stop

`npm run test:http` tests authentication and MCP negotiation against the local endpoint, without browser access. Set `THREADS_REMOTE_URL` to the HTTPS MCP URL to test through the tunnel. Set `THREADS_HTTP_LIVE=true` for two real account reads. The test writes only a private, count-only report, never tokens or post text.

Remote requests run one at a time; a concurrent request receives 429 with Retry-After. Do not run a second controller on the same browser tab during a research call.

Stop cloudflared to remove external access. Stop `serve-http` to remove the local remote endpoint. Removing or changing `remote-access.token` immediately revokes the old token on the next request; it does not cancel an already running read. The server never recreates a removed token while running. Restarting `serve-http` creates a replacement if the file is absent. The bridge and Chrome may continue running independently. Sleep, a restart, Chrome closure or extension disconnect interrupts live reads.
