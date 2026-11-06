# Connect an existing Chrome Threads tab

This bridge lets the user select an already signed-in Threads tab. It does not create a browser profile, read cookies, inspect other applications, or automatically choose another tab.

1. Build the project, including the bundled `extension/runtime.js` supplied by the root build process.
2. Start the MCP in extension-provider mode or run its standalone bridge helper. The default port is `19758`, bound exclusively to `127.0.0.1`.
3. Open `http://127.0.0.1:19758/` to see the current process's pairing code.
4. In Chrome, open `chrome://extensions`, enable Developer mode and use **Load unpacked** to select the project's `extension` folder. This is a local unpacked extension, not a published Chrome Web Store listing.
5. Manually select the desired, signed-in Threads tab. Click the extension icon, enter the port and pairing code, then click **連接此分頁**. Only that tab is bound.
6. To take control, disconnect in the popup. Closing the tab, navigating outside Threads or stopping the local bridge also disconnects it. Reconnection always requires a user click; requests are never automatically replayed.

The popup stores its pairing code in `chrome.storage.session`, which does not survive a browser restart. The host saves current pairing information in `bridge-pairing.json` beneath its private data directory, removes its own pairing file on orderly shutdown and generates a fresh token for a new server instance. Do not publish that directory or share the pairing code.

Read, snapshot, navigation, scrolling and opening follower/following/liker panels operate on the selected bound tab in the background. You can use another tab or another application while those reads run; the extension does not activate or focus Threads. General interactions still require the bound tab to be active. A screenshot additionally requires its window to be focused; active-tab identity is checked before and after capture. The extension never switches tabs or windows itself.

Version 0.1.1 removes the foreground requirement from scrolling and read panels. Version 0.1.2 fixes overlapping connection attempts and reply parsing, and exposes page visibility for verification. Existing unpacked installations need one manual **Reload** in `chrome://extensions`, followed by reconnecting the intended Threads tab. No permissions were added. The current browser tool cannot operate `chrome://extensions`; ask the user to perform this deployment step.

The popup and its local status response show the currently loaded extension version. Before using the page runtime, the connector checks that `ThreadsMCP.runtimeVersion` matches its own manifest version; an old runtime is replaced with the installed extension's bundled runtime. Matching versions preserve existing snapshots. Rebuilding files on disk does not update an already loaded Chrome extension; reload is still required to activate a new extension version.

Navigation is sent once and waits up to 20 seconds for both the bound tab URL and a fixed read-only DOM readiness check to match the requested destination. A late `complete` event from the previous page cannot finish the request. Legacy `threads.net` and bare-host redirects to `www.threads.com` are accepted, while a different path/query is not. Disconnect cancels readiness polling immediately. The readiness check establishes that the requested document loaded; it does not guarantee that Threads has exposed all feed items or replies.

## Interface and limits

`BridgeServer({ dataDir, port?, commandTimeoutMs?, authTimeoutMs? })` exposes `start()`, `status()`, `command<T>(command)` and `close()`. Status includes the pairing URL and bound tab, never the token.

Supported commands use a `type` discriminator:

```json
{"type":"navigate","url":"https://www.threads.com/@example"}
{"type":"read"}
{"type":"snapshot"}
{"type":"interact","snapshotId":"...","ref":"...","verb":"click"}
{"type":"scroll","pixels":700}
{"type":"open_read_panel","panel":"followers"}
{"type":"screenshot"}
```

Interaction verbs are `click`, `fill`, `press`, `select` and `check`; optional `value` is passed to the page runtime. The root MCP driver controls write settings and prepared-action approval. The bridge is a transport and is not a substitute for that policy. The page runtime validates snapshot freshness and element references.

The host accepts WebSocket upgrades only from Chrome extension origins, validates the exact loopback Host header and authenticates the first message with a random session token. There is one authenticated connection at a time. Commands carry random request IDs; responses must match a currently pending ID. Default command timeout is 30 seconds; authentication timeout is five seconds. Disconnect rejects pending requests; a timeout explicitly reports that the outcome may be unknown. Neither condition causes retries.

Host-to-extension commands are capped at 64 KiB, received WebSocket messages at 4 MiB and extension replies at 3.9 MB. Oversized results return an error instead of silently sending a partial result. A maximum of 16 pending host commands is allowed. The extension executes commands serially. Runtime injection checks for the existing `ThreadsMCP` object first, preserving snapshots until navigation or the runtime's own invalidation.

The pairing page uses no-store, frame denial and a restrictive CSP, and rejects cross-site requests and non-loopback Host headers. The extension requests only `activeTab`, `scripting`, `storage`, Threads host access and localhost host access; it does not request `cookies`, `debugger`, or general browsing history access.

Automated transport tests use synthetic WebSocket clients and do not access Threads or install the extension. A successful bridge test does not establish that the extension is loaded, paired, or reading a real logged-in account; these require explicit live verification.

## Persistent host and MCP clients

Keep the standalone bridge host running to preserve the extension connection when an individual stdio MCP client or smoke test exits. `RemoteExtensionDriver({ dataDir, port? })` attaches to that host with `await connect()`, reads the local pairing file and exposes the same `command()`, cached synchronous `status()` and `close()` interface as the other browser drivers. Its `close()` only closes that client's local state; it does not stop the host or disconnect the browser. Repeated `connect()` calls refresh connection status while waiting for the user to pair.

Remote requests always target numeric IPv4 loopback, using only the validated numeric port in the pairing file. An optional constructor port must match the file. The file's URL field is ignored. HTTP redirects are rejected. `GET /status` and `POST /command` require the exact bearer token, an absent Origin header, a valid loopback Host header and no cross-site fetch indication. They never return the token. POST requests require a JSON object and have a 64 KiB limit; the existing command allowlist applies. Every command response includes current host status; errors are sanitized instead of echoing page text or request data. Clients serialize their commands and never retry them automatically.

Only `BRIDGE_PAIRING_MISSING` or `ECONNREFUSED` should make the CLI start a new host. Invalid pairing information (`BRIDGE_PAIRING_INVALID`), unreadable files or authentication errors (`BRIDGE_AUTH_FAILED`) must be reported, not silently replaced by another service. The default remote timeout is 35 seconds, slightly longer than the bridge's 30-second command timeout. A timeout retains an unknown-outcome warning and never triggers replay.

## v0.3.0 social and media transport

New allowlisted commands are social operation stage/commit/inspect and media operation begin/chunk/finish/abort. No extension permissions were added. These use their own account/target/composer guards and can run in the selected background tab; generic interact and screenshot guards remain unchanged. Media uses 32 KiB binary chunks within the 64 KiB JSON ceiling. Neither transport success nor media staging proves publication. Runtime error prefixes now preserve actionable codes such as AMBIGUOUS_UI instead of collapsing every failure to PAGE_COMMAND_FAILED.
