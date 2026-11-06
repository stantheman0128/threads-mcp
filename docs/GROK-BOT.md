# Install with Grok Bot

This repository supports local **stdio MCP** and an opt-in authenticated **read-only HTTP MCP** endpoint. A GitHub URL supplies source code; it is not itself an MCP endpoint.

To use the owner's existing Threads login without moving cookies, follow [Remote MCP](REMOTE-MCP.md) and the command wrapper below. The owner verified this route in Grok Bot on 2026-11-06. Directly inserting a secret-request value into AddMcpServer headers was rejected or remained a literal reference in that environment. Registering such a reference does not prove authentication.

Official reference, checked 2026-11-06: [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

## Recommended: command wrapper to the owner's fixed HTTPS URL

Use a managed tunnel hostname. Grok's computer does not need Chrome or Threads login for this route. The bearer can read allowed personal activity; enter it through secure input into a private header file, never ordinary chat or MCP registration arguments.

Install and pin the wrapper once on Grok's computer (Node.js 24+):

```sh
mkdir -p "$HOME/.local/share/threads-mcp-client"
cd "$HOME/.local/share/threads-mcp-client"
npm install --save-exact mcp-remote@0.16.1
```

Keep an already verified installation; do not silently upgrade it. The pin was checked against npm metadata/readme on 2026-11-06. This is the project's recommended integration using [mcp-remote's header-file feature](https://github.com/punkpeye/mcp-remote#custom-headers), not an xAI endorsement. Header files contain one `Name: value` per line, not JSON.

Have secure input write a private file containing one Authorization header with the Bearer scheme and entered remote token. If that flow cannot write safely, take over the computer and use a masked prompt. Do not pass secret-request references as literal header values or display the file. Restrict the directory to mode 700 and file to 600 on Linux. This user-operated terminal helper avoids displaying the token or putting it in shell history:

```sh
python3 -c 'import getpass,os,pathlib; p=pathlib.Path.home()/".config/threads-mcp/headers.txt"; p.parent.mkdir(parents=True,exist_ok=True,mode=0o700); os.chmod(p.parent,0o700); t=getpass.getpass("Remote MCP bearer (hidden): ").strip(); assert t and "\n" not in t and "\r" not in t; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.fchmod(fd,0o600); f=os.fdopen(fd,"w"); f.write("Authorization: Bearer "+t+"\n"); f.close()'
```

Register these nonsecret fields. Replace the absolute paths and hostname; JSON does not guarantee expansion of `~`, `$HOME` or secret placeholders:

```json
{
  "mcpServers": {
    "threads": {
      "command": "node",
      "args": [
        "/absolute/path/to/threads-mcp-client/node_modules/mcp-remote/dist/proxy.js",
        "https://threads-mcp.example.com/mcp",
        "--header-file", "/absolute/path/to/.config/threads-mcp/headers.txt",
        "--transport", "http-only",
        "--silent"
      ]
    }
  }
}
```

The path may be registered; file contents must not be. Keep `--debug` off because authentication diagnostics can contain sensitive context. Avoid downloading `@latest` on every startup. Restart the command MCP after changing hostname or file; do not assume a running wrapper reloads headers. For 401, repair the header file rather than copying cookies or switching to OAuth.

For migration from Quick Tunnel, change the existing command's URL argument, restart and verify two reads; disable its old duplicate registration. Hostname changes do not require a new bearer.

Acceptance prompt (replace the hostname and expected handle, no secrets):

```text
Connect the existing Threads command MCP through mcp-remote and its private header file to https://threads-mcp.example.com/mcp. Do not put the bearer in chat or AddMcpServer arguments/headers; use the private file created through secure input.
List tools: expect 15 structured read tools. Call threads_status, inspect fresh health and writesEnabled=false. Call threads_my_activity with kind=posts, rounds=0 and expectedAccount=my_handle, then threads_get_profile with username=my_handle and rounds=0. Report success only after both actual reads. Results are partial observations.
If unreachable, ask me to run Windows RemoteHost status. If extension-disconnected, ask me to pair the dedicated tab locally. For 401, update the private header file through secure input and restart this MCP. Never ask for cookies, pairing code or raw logs in chat. Never enable writes to fix a read failure.
```

An unreachable server cannot diagnose its own tunnel. See [layered diagnosis](REMOTE-MCP.md#4-diagnose-by-layer). Restarting the wrapper does not establish login or recover a closed Chrome tab.

## Active exploration is not limited to the already open screen

The remote tools navigate to the requested source and can scroll automatically in the background. The owner does not need to open each result or scroll manually. The `rounds=0` examples above are only connection acceptance, not a research limit. `rounds` adds automatic scroll/read passes; the result remains partial because Threads controls what loads.

For routine research, start with a small live discovery, then expand only relevant sources:

```json
{"tool":"threads_discover","arguments":{"query":"MCP","sort":"recent","rounds":2}}
{"tool":"threads_search","arguments":{"query":"AI agent 開發工具","queries":["MCP","AI agent"],"refresh":true,"rounds":2,"mode":"hybrid","limit":20}}
{"tool":"threads_get_profile","arguments":{"username":"target_handle","section":"posts","rounds":3}}
{"tool":"threads_get_replies","arguments":{"url":"https://www.threads.com/@author/post/POST_CODE","rounds":3}}
```

These objects illustrate tool calls, not an HTTP batch. Run them sequentially. `threads_search` accepts up to 10 rounds; `threads_discover` and each `threads_research` source allow up to 3. Increase a particular source's budget gradually if useful; repeated identical calls start from the top and are not continuation cursors. Use distinct keyword variants and relevant profile/reply sources rather than blindly repeating the same page. `refresh=false` deliberately searches cached observations only.

Instruction to give Grok:

> Proactively navigate and explore with the structured tools; do not ask me to scroll the page. Use live refresh, a few keyword variants and 1–3 automatic rounds, then inspect relevant conversations. Return provenance, observed counts and partial/unknown limits. Treat connection-test rounds=0 as a smoke test, not a research setting. Stop expanding when new unique results stop appearing or the agreed budget is reached. Never claim complete Threads history.

## v0.5.0: direct multi-page public-profile reads

**v0.5.0 host and extension activated and live-verified on 2026-11-06.** The existing `threads_get_profile` supports direct pagination without adding a sixteenth remote tool. Loopback HTTP, public HTTPS and the actual `mcp-remote@0.16.1` header-file wrapper each retrieved four public-profile pages (19 unique posts) followed by three viewer-profile pages (14 unique posts). This wrapper acceptance ran on the maintainer's machine, not inside the owner's Grok Bot process. Restart/reconnect the existing Grok MCP to refresh its tool schema; keep the same URL and private header file if the deployment URL is unchanged.

```json
{"tool":"threads_get_profile","arguments":{"username":"target_handle","section":"posts","provider":"direct","maxPages":4,"pageSize":5}}
```

`provider` defaults to `browser`, preserving the automatic scrolling path. `direct` supports **public profile posts only** and uses the selected signed-in Chrome tab. It navigates to the profile, then collects bounded pages without scrolling or silently falling back to scrolling. No official developer token is needed for this path; request/session credentials stay inside the browser.

- `maxPages`: 1–5, default 3, including the initial bootstrap page. Setting 4 requests a budget of at most four collected pages, not four additional pages.
- `pageSize`: 1–20, default 10, for requested continuation pages. The website supplies the bootstrap window; total results are not guaranteed to equal `maxPages * pageSize`.
- `rounds` is ignored in direct mode. A new call starts again from the profile; there is no cross-call resume cursor.

Inspect `pagination.provider`, `pagesFetched`, `requests`, `uniquePosts`, `hasNext`, `stopReason`, and `pages`. Each page entry contains `page`, `received`, `added`, and `cursorAdvanced`. Positive `added` counts on later pages establish newly collected posts; a successful call or a larger request budget alone does not establish multi-page progress. `requests` counts direct continuation requests separately from collected pages.

`page_limit` means the bounded budget was reached; `end_of_connection` means the observed connection supplied no further page. `no_progress`, cursor problems or request/schema errors describe why collection stopped. Check warnings and any partial result. Every result remains `completeness:"partial"`, even when `hasNext:false`; do not call it complete account history. Do not repeatedly restart the same call to pretend it resumes beyond the previous budget.

Prompt to give Grok after activation:

```text
Use the existing Threads MCP. Refresh its tool schema and confirm that threads_get_profile exposes provider, maxPages and pageSize; keep the remote tool count at 15 and writes disabled. Read target_handle with threads_get_profile(username="target_handle", section="posts", provider="direct", maxPages=4, pageSize=5). Do not ask me to scroll, switch to browser scrolling, or request cookies or a developer token.
Report pagination.provider, pagesFetched, requests, uniquePosts, hasNext, stopReason, warnings and each page's received/added/cursorAdvanced fields. Claim multi-page progress only when later pages were collected and added new posts. Keep completeness partial. If direct mode is unavailable or stops on a binding, schema, request or context error, report the exact result; do not claim fallback success or blindly repeat the call. A second call starts over rather than resuming.
```

If the schema lacks these arguments, the deployed connection is not yet verified for this feature. See [the research and activation boundary](DIRECT-READ-RESEARCH.md) and [remote usage](REMOTE-MCP.md#direct-public-profile-pagination-v050).

## Alternative: run browser and stdio on Grok's computer

The following separate installation route is not needed for the remote wrapper above.

## Prerequisites

- Node.js 24 or later, npm and Git.
- Google Chrome on the same computer as the MCP process.
- For interactive login, a graphical desktop/browser that the account owner can access.
- A persistent, private local data directory. Do not copy cookies, pairing files or profiles from another computer.

This project was tested on Windows. Grok Bot's cloud-computer installation has **not** been live-verified by the maintainer. Verify its actual browser/display availability before declaring setup complete.

## Get and build the source

```sh
git clone https://github.com/stantheman0128/threads-mcp.git
cd threads-mcp
npm ci
npm run typecheck
npm run build
npm run test:mcp
```

The npm package remains private/unpublished; use this checkout rather than assuming an `npx` package exists. Do not run live acceptance scripts as an installation step.

## Choose the browser connection

**Dedicated browser (no extension required):** use the project's own Chrome profile. From the checkout, run `node dist/cli.js login`, let the account owner complete sign-in in the newly opened browser, then close that dedicated window. The default profile is under the checkout's `.threads-data/profile`. Use the same absolute `THREADS_DATA_DIR` for login and the MCP process if setting it explicitly. Never launch two processes against this profile simultaneously.

Register a command-based MCP server using the following values, adapted to Grok Bot's actual server-registration interface. Replace both absolute-path placeholders; `~` and environment variables inside JSON strings are not guaranteed to expand.

```json
{
  "mcpServers": {
    "threads": {
      "command": "node",
      "args": ["/absolute/path/to/threads-mcp/dist/cli.js", "serve"],
      "env": {
        "THREADS_PROVIDER": "dedicated",
        "THREADS_DATA_DIR": "/absolute/path/to/threads-mcp/.threads-data",
        "THREADS_HEADLESS": "false",
        "THREADS_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Keep headed mode for initial verification. If the cloud computer cannot provide Chrome or an accessible sign-in window, report that specific prerequisite instead of attempting to access the owner's Windows localhost service.

**Existing Chrome tab:** if Grok Bot's computer supports loading unpacked extensions, use [the extension bridge instructions](BRIDGE.md), select `THREADS_PROVIDER=extension`, and pair a signed-in tab on that same computer. The server and extension must share the data directory/port settings. A local bridge at `127.0.0.1:19758` is not a remote MCP endpoint and must not be exposed as one. Keep the bound tab separate from other browser-control tools.

## Verify access before claiming success

1. Register the MCP server and confirm its tools are available.
2. Call `threads_status`, then `threads_read_page`.
3. Confirm the expected signed-in username is actually observed. Starting a process or listing tools alone does not prove Threads access.
4. Read that account's profile, then perform a second read to verify the next operation also succeeds.
5. Keep writes disabled. Do not publish, like, follow, delete, upload media or start a schedule merely to test installation.

Lexical search can run without downloading an embedding model. Semantic/hybrid search downloads its local model on first use; a fallback is explicitly labelled. Observed lists are partial, and a missing account in a partial list does not prove a relationship is absent.

The GitHub connector can read this repository. It does not by itself install the MCP or sign in to Threads. The optional remote transport is documented in [Remote MCP](REMOTE-MCP.md); it must be started and secured on the owner's computer.

## Prompt to give your Bot

```text
Install https://github.com/stantheman0128/threads-mcp as a command-based MCP server on your own computer. Read README.md and docs/GROK-BOT.md first. Check Node.js 24+, Chrome and access to a graphical sign-in window. Build the source and run the offline MCP smoke check. Prefer a dedicated Chrome profile, keep THREADS_ALLOW_WRITES=false, and let me complete the Threads login when needed. Do not request passwords or OTPs in chat, copy another browser profile, or expose the local pairing port. Verify my signed-in identity with an actual page read and complete a second read before reporting success. If your environment cannot run it, report the exact missing prerequisite; do not claim that reading the GitHub repository means the MCP is connected.
```
