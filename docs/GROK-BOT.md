# Install with Grok Bot

This repository supports local **stdio MCP** and an opt-in authenticated **read-only HTTP MCP** endpoint. A GitHub URL supplies source code; it is not itself an MCP endpoint.

To use the owner's existing Threads login without moving cookies, follow [Remote MCP](REMOTE-MCP.md). Grok Bot connects to the owner's HTTPS `/mcp` URL using an independent bearer token entered through a secure secret form. The remaining instructions below describe the alternative: installing and signing in on Grok Bot's own computer.

Official reference, checked 2026-11-06: [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

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
