# Read-only official API acceptance checks

Run `node --import tsx scripts/api-live-smoke.ts --expected-account YOUR_THREADS_USERNAME` from the project directory after the server environment has a valid official Threads API token. The expected username is a nonsecret assertion; `THREADS_API_EXPECTED_ACCOUNT` is its environment equivalent. Do not pass tokens as command-line arguments or write them into this document.

The script uses `OfficialThreadsApi` with `THREADS_API_ACCESS_TOKEN` and optional numeric `THREADS_API_USER_ID`; it explicitly disables writes even when `THREADS_ALLOW_WRITES=true` exists in the parent environment. A configured numeric ID and an expected username, when supplied, must both match `/me`. A mismatch stops after that identity request, before posts or other content are read. Without either identity assertion, the result can be at most PARTIAL.

The script never calls prepare/execute or any mutation endpoint, creates no media containers, exchanges no credentials, does not retry, and does not follow pagination. It makes at most 11 sequential requests with the adapter's bounded timeout. It does not register a Meta developer account, accept terms, create an app, request scopes, or complete OAuth consent. Those are separate setup prerequisites.

| Probe | Bound and acceptance meaning |
| --- | --- |
| Own identity | Required: valid API ID/username and all configured identity assertions match |
| Own posts | Required: one page, at most five requested posts; a valid empty array passes access verification |
| One own post | Optional: returned ID matches the selected own-post ID |
| Replies and conversation | Optional: one requested result each for the selected own post |
| Post insights | Optional: `views` schema access for the selected own post; metric values are discarded |
| Account insights | Optional: `views` schema access; metric values are discarded |
| Mentions | Optional: one requested result |
| Search | Optional: one RECENT result for the fixed keyword `Threads`; records only whether a different author's result was observed |
| Public profile | Optional: the standard-access `meta` profile; this does not prove advanced discovery access |
| Publishing quota | Optional: read-only quota endpoint access; no publication is attempted |

If the own-post page has no usable post ID, post/reply/conversation/post-insight probes are SKIPPED. This is not an account failure: the baseline access checks still pass, but overall coverage is PARTIAL. Successful empty replies, mentions, search or insights establish access only, not successful content discovery. Authentication, rate-limit or transport failure stops subsequent probes without retries; permission-specific rejection leaves independent probes available.

## Results and exit codes

- **PASS / 0:** identity is pinned, both required checks passed, and every optional endpoint returned the minimal expected schema. This means bounded read-only access was verified. It does not certify all OAuth scopes, advanced app review, complete history, or any write capability.
- **PARTIAL / 2:** required identity and own-post access worked, but identity was not pinned, or at least one optional endpoint was blocked/skipped.
- **BLOCKED / 3:** credentials/setup are unavailable, identity mismatched, or a required baseline check did not succeed. Missing credentials cause zero network requests.

Evidence is written to a uniquely named JSON file under `THREADS_DATA_DIR/api-live-checks/`, defaulting to `.threads-data/api-live-checks/`. Files use restrictive creation mode where the OS supports it. Reports contain only timestamps, operation names, statuses, counts, empty-response flags, whitelisted error codes/HTTP statuses and a one-way identity fingerprint with match flags. They omit tokens, raw API bodies/error messages, usernames/account IDs, post text, media URLs and insight values. The console prints the sanitized summary and evidence-file path. A setup or evidence-write failure returns BLOCKED without echoing the underlying exception.

The evidence records whether authenticated reads actually ran. An offline fixture PASS proves the verifier logic only; it is not live acceptance. Keep missing-credential BLOCKED evidence distinct from a later authenticated result.

Integration points: an npm script such as `test:api-live` may invoke this file; onboarding can run it after OAuth and inspect exit code plus report; CI should use injected fixtures rather than real accounts. Do not include credentials in npm commands or enable this live check implicitly in the default offline test suite.
