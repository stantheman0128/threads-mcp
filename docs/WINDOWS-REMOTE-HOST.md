# Windows remote host: login startup, recovery and diagnosis

Run these commands at the checkout root in Windows PowerShell. Use one checkout/data directory consistently; do not run a second host against another copy's private state. Requires a built `dist/cli.js`, Node.js 24+, cloudflared 2025.4.0+ and an interactive Chrome login. No administrator account/password is required by the task definition. If Windows policy denies task registration, report that prerequisite instead of changing policy globally.

## Initial setup

1. Configure the [managed tunnel's fixed hostname and origin](REMOTE-MCP.md#1-configure-the-permanent-route-once). Origin is only `http://127.0.0.1:19759`; route HTTP Host Header must be `127.0.0.1:19759`. **Never expose 19758**.
2. Build and create a private nonsecret supervisor configuration. Substitute your hostname:

```powershell
npm ci
npm run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action init -Hostname threads-mcp.example.com
```

The default configuration is `.threads-data/remote-host/config.json`. `init` does not create credentials, start services or enable the tunnel. It writes all optional remote capability flags as `false`, so remote access starts with the base read-only tools. Existing schema-version-1 configurations without these fields also default to false. It locates Node/cloudflared; use `-NodePath` and `-CloudflaredPath` if needed. Paths with spaces are passed as arguments, not composed shell commands. Configuration can be inspected safely but should remain in the private directory.

3. Save the Cloudflare connector token into `.threads-data/remote-host/tunnel.token` using a local editor. Paste only the token, not the full installation command. Do not type it into the terminal command line or share it in chat. This secret is separate from the existing MCP bearer.
4. **Keep an existing `remote-access.token`** to preserve Grok's current authentication. For a genuinely new installation without either a token or a revocation marker, generate the first bearer without printing it:

```powershell
if (-not (Test-Path .threads-data/remote-access.token) -and -not (Test-Path .threads-data/remote-access.initialized)) {
    node dist/cli.js remote-token rotate
}
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action protect-secrets
```

A marker with no token means intentionally revoked; this step must not undo it. Use explicit `remote-token rotate` only when you intend to restore access, then protect the new file and update Grok's secure header file. The protection action applies current-user/SYSTEM ACLs only to the known MCP/tunnel token files; it never displays their contents.

5. Enable the managed connector in the nonsecret config, validate, install the login task and start it:

```powershell
$threadsConfigPath = Join-Path (Get-Location) '.threads-data/remote-host/config.json'
$threadsConfig = Get-Content -LiteralPath $threadsConfigPath -Raw | ConvertFrom-Json
$threadsConfig.tunnelEnabled = $true
$threadsConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $threadsConfigPath -Encoding UTF8
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action validate
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action start
```

Installation registers the task; **Start is separate**. It runs hidden at the current user's next login with limited privileges. Do not also install a second cloudflared service for the same host. If bridge/HTTP/tunnel is already running manually, the supervisor reports the occupied port as externally managed and leaves it untouched. At a chosen maintenance point, stop only your old processes, then Stop/Start this supervisor to give it ownership; do not kill arbitrary PIDs from a port listing. Existing connections may be interrupted by that deliberate handover and bridge pairing will change.

## From login to a verified Grok read

1. Log into Windows and keep it awake/online. The login task starts the services.
2. Open Chrome and the dedicated signed-in Threads tab. Open `http://127.0.0.1:19758/`, copy the current pairing code into the extension popup and press **連接此分頁**.
3. Inspect status:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action status -CheckPublic
```

4. Confirm local HTTP health, bridge connected and tunnel readiness. The optional public check is **anonymous**: 401 is expected when the route reaches the authenticated endpoint; no bearer is sent externally by this check. It does not prove a Grok credential or actual account read.
5. Register/restart the [Grok command MCP](GROK-BOT.md) for the fixed URL. Verify `threads_status`, `threads_my_activity` with expectedAccount, and a subsequent profile read. Follow [REMOTE-MCP.md](REMOTE-MCP.md#4-diagnose-by-layer) for failure meanings.

## What is monitored and restarted

Default ports: bridge 19758, HTTP 19759, cloudflared metrics 19760, all loopback. A named-pipe lock prevents duplicate supervisors for one config. Polling checks child exits, occupied ports, authenticated `/healthz` and the connector's `/ready`. Restart backoff is capped; a stable run resets the crash count. A live but unhealthy process is diagnosed rather than repeatedly killed. cloudflared itself reconnects transport after transient networking failures.

Only child processes launched and still owned by this supervisor can be stopped/restarted. Unowned listeners are never adopted or killed. The report distinguishes current owned processes from external listeners. The supervisor does not open a browser, recreate a closed tab, choose an account, replace a manual disconnect, or retry browser commands. Health checks never read Threads page content.

Logs are under the configured private state directory (by default `.threads-data/remote-host/`):

- `status.json`: latest timestamped layer/process status.
- `events.jsonl` and `events.previous.jsonl`: bounded, sanitized lifecycle events.
- `stopped.json`: persistent user stop; only explicit Start clears it.

Raw child stdout/stderr is not persisted, because third-party startup/debug output can contain secrets. Events report safe error categories/exit status, not headers, token files, cookies or full command lines. A stale status file is not evidence of a running supervisor; the live status command also probes current state.

## Optional controlled remote writes and media

All capability settings below are explicit opt-ins; omitted fields remain off. The following base-mode counts assume the six additional capability flags in the next table are disabled.

`remoteWritesEnabled` and `remoteMediaEnabled` are optional JSON **booleans**, each defaulting to `false`. Strings such as `"true"`, null and other types are rejected; unknown configuration fields are still rejected. Media requires both opt-ins: `remoteMediaEnabled:true` with omitted or false `remoteWritesEnabled` is invalid.

| `remoteWritesEnabled` | `remoteMediaEnabled` | Remote security mode |
| --- | --- | --- |
| `false` | `false` | **15 read-only tools** |
| `true` | `false` | **18 tools**: 15 reads plus 3 controlled social-action tools |
| `true` | `true` | **19 tools**: controlled mode plus `threads_stage_media_remote`, one tool with multiple operations |
| `false` | `true` | Rejected configuration |

The write/media workflow still requires its prepared-action and authorization checks; these settings alone do not authorize a particular upload or social action. Give the remote bearer only to clients trusted for the enabled mode.

| Additional boolean setting | Child environment flag | Requires `remoteWritesEnabled:true` |
| --- | --- | --- |
| `remoteExtendedReadsEnabled` | `THREADS_REMOTE_ALLOW_EXTENDED_READS` | No |
| `remoteDeleteEnabled` | `THREADS_REMOTE_ALLOW_DELETE` | Yes |
| `remoteScheduleEnabled` | `THREADS_REMOTE_ALLOW_SCHEDULE` | Yes |
| `remoteBrowserFallbackEnabled` | `THREADS_REMOTE_ALLOW_BROWSER_FALLBACK` | Yes |
| `remoteMessagesEnabled` | `THREADS_REMOTE_ALLOW_MESSAGES` | No |
| `remoteOfficialApiEnabled` | `THREADS_REMOTE_ALLOW_OFFICIAL_API` | Yes |

All six fields use the same strict boolean validation and default to false. Extended reads and messages can be explicitly enabled without controlled writes; media, delete, scheduling, browser fallback and official API require controlled writes. Contradictory settings are rejected. Match the client tool list to the selected capabilities rather than assuming the base-mode counts apply when additional flags are on.

**Messages and official API remain off by default.** Enable messages only for a client trusted to access private message content; reading that view can affect read state. Official API access needs its own server-side API configuration and permissions; the remote bearer or Chrome login is not an official API credential. Without configured API credentials, HTTP still starts and API status reports unconfigured; actual API requests fail closed. Do not put API tokens in this JSON configuration, logs or chat, and do not create a new supervisor secret file for them.

When official API is enabled, the supervisor forwards existing host-owned `THREADS_API_ACCESS_TOKEN` and `THREADS_API_USER_ID` environment configuration only to the HTTP child. They remain excluded from bridge, tunnel and validation children, and are excluded everywhere when the capability is disabled. The supervisor does not provision these credentials; its scheduled invocation must already receive the intended host configuration. Validation/status output contains capability booleans, never credential values.

The supervisor derives every `THREADS_REMOTE_ALLOW_*` flag listed here solely from the validated configuration. It always sets the broader `THREADS_ALLOW_WRITES=false`; no allow flag is inherited from the launching shell. Setting an environment variable in a parent terminal cannot enable a capability or override a read-only supervisor configuration.

To intentionally change mode, stop the current supervisor first, update the private config, validate, then explicitly start it. The example below enables controlled writes while explicitly leaving every other capability disabled. Select only the required flags. Set writes and media to true for controlled media; set every remote flag to false to return to the base read-only mode. It preserves unrelated settings and adds optional fields to older files:

```powershell
$threadsConfigPath = Join-Path (Get-Location) '.threads-data/remote-host/config.json'
$threadsRemoteWrites = $true
$threadsRemoteMedia = $false
$threadsOptionalCapabilities = @{
    remoteExtendedReadsEnabled = $false; remoteDeleteEnabled = $false
    remoteScheduleEnabled = $false; remoteBrowserFallbackEnabled = $false
    remoteMessagesEnabled = $false; remoteOfficialApiEnabled = $false
}
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action stop -Config $threadsConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Stop did not complete; do not continue the mode change.' }
$threadsConfig = Get-Content -LiteralPath $threadsConfigPath -Raw | ConvertFrom-Json
$threadsConfig | Add-Member -NotePropertyName remoteWritesEnabled -NotePropertyValue $threadsRemoteWrites -Force
$threadsConfig | Add-Member -NotePropertyName remoteMediaEnabled -NotePropertyValue $threadsRemoteMedia -Force
foreach ($threadsFlag in $threadsOptionalCapabilities.Keys) {
    $threadsConfig | Add-Member -NotePropertyName $threadsFlag -NotePropertyValue $threadsOptionalCapabilities[$threadsFlag] -Force
}
$threadsConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $threadsConfigPath -Encoding UTF8
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action validate -Config $threadsConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Validation failed; leave the supervisor stopped and correct the config.' }
# Run Start only when intentionally resuming this host.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action start -Config $threadsConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Start failed; inspect status before retrying.' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action status -Config $threadsConfigPath
```

Editing or validating the configuration does not clear a persistent Stop. If the host was intentionally stopped, leave it stopped until explicit resume is wanted. These steps do not reinstall the login task. A running supervisor does not hot-reload the setting, and external/unmanaged listeners remain untouched; resolve any deliberate ownership handover separately.

After Start, re-pair the selected Chrome tab if the bridge restarted, then refresh the client's MCP tool schema. Confirm the tools match the selected flags. Local `validate` and `status` report all eight configured remote flags; a successful HTTP probe also reports the observed mode. Health accepts `threads-mcp-readonly` for the default mode or `threads-mcp-controlled` with `writesEnabled:true` for controlled mode, retaining revision `remote-health-1`. Its `mediaEnabled` must match the configured media setting; an older response without that field is accepted only when media is disabled. Its `capabilities` object must contain matching booleans for `extendedReads`, `delete`, `schedule`, `browserFallback`, `messages` and `officialApi`; an older response without the object is accepted only when all six are disabled. A mismatch is `unexpected-response`, not evidence that the requested configuration is active. Verify an actual read after recovery; do not upload media, read private messages or perform a social write merely to test the toggles.

## Stop, restart, uninstall

```powershell
# Persistent pause: stops only this supervisor's owned children.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action stop
# Explicitly resume after a pause or a config change.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action start
# Remove this login registration; preserve private data and Chrome.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\RemoteHost.ps1 -Action uninstall
```

Use `-Config C:\absolute\private\remote-host\config.json` consistently for custom state; the config parent must be named `remote-host`. Do not expect a running supervisor to hot-reload configuration; Stop, edit, validate and Start. After a bridge restart, pair the extension using its new local code. Abrupt termination of the supervisor can leave surviving children: a subsequent run treats them as external/unmanaged and requires a deliberate maintenance handover. Logout/sleep, login expiry, challenges, policy-denied tasks, live hung processes, DNS/Cloudflare route errors and disconnected tabs still require the indicated user action. No startup task makes the laptop reachable while powered off or asleep.
