# Local media staging

`MediaController.uploadFiles(paths, expectedAccount)` transfers explicit absolute local file paths into the selected Threads tab's empty composer. Writes must be enabled. No cookie access, additional extension permissions, arbitrary JavaScript command, remote downloading, publish click or automatic retry is part of this operation.

Supported signatures and filename extensions are JPEG, PNG, GIF, WebP, MP4/M4V, QuickTime MOV and WebM. Signature checks reject obvious format mismatches; they do not certify codec compatibility or a complete valid media stream. The Threads preview is the application check. Limits are 20 files, 8 MiB per image, 64 MiB per video and 64 MiB total. Controller options can reduce these limits. Files must be regular and nonempty; changes detected while reading abort the transfer. File paths are not sent to the browser; only basenames, MIME types, sizes, hashes and bytes are transferred.

Use this sequence:

1. Enable writes and open one empty composer manually or through the existing prepared browser interaction flow.
2. Call `threads_stage_media` with the explicit local file paths and expected account. It uses `media begin/chunk/finish` commands, with base64 chunks of at most 32 KiB decoded bytes, within the bridge's 64 KiB command limit.
3. Inspect the actual preview and wait for upload/processing. A `staged` result means file assignment and input events were dispatched; `previewReady: null` explicitly does not establish readiness or publication.
4. Pass the returned `mediaToken` into the prepared social action. Preparation and commit check the exact composer, account, URL, file input and File objects. A visible blob-image/video preview is required, and its nodes and sources are bound at preparation. If the site replaces its file input, clears its file list, uses unsupported preview markup, or changes the preview, preparation fails conservatively.
5. Review and commit the prepared social action separately. Media staging never publishes.

The composer must have exactly one visible dialog, one visible text editor and one file input. Existing draft text or attachments are preserved by refusing to stage over them. Changing the account, route, editor, file input or attachment state during transfer rejects subsequent chunks or finish. Trusted manual interaction takes over and invalidates media approval even when attachment/text contents appear unchanged. The single active transfer expires after five minutes and discards its memory buffers; media approval expires after ten minutes. Abort discards pending bytes without modifying a composer. A timed-out finish is not replayed or undone: inspect the current page to establish its outcome.

Alt text through browser UI is explicitly unsupported until a reliable control is available. Supplying `altTexts` fails before transfer; the controller never silently drops a supplied description. Use the official API's supported media/alt-text route when appropriate. Official API public media URLs are separate from local-file browser staging.

Offline verification: `npx tsx --test tests/media.test.ts`. Browser fixtures are opt-in with `THREADS_BROWSER_TESTS=true`; all network requests are intercepted and served local fixture HTML. They verify byte reconstruction, account mismatch, manual-draft preservation, stale composer rejection, single-use finish, preview gating and attachment replacement. No real account is uploaded to or published during tests.

Remote clients use the separately enabled byte-upload protocol, never these local paths. See [controlled remote media](REMOTE-MCP.md#controlled-remote-media-v060) for upload IDs, status recovery, quotas and the separate prepared publication step.
