# Threads MCP

- Keep runtime profiles, cookies, captured private pages, models and the local post database in `.threads-data/` (gitignored) or `THREADS_DATA_DIR`.
- No credentials in tool results, docs, test fixtures or logs. Use a dedicated browser profile or the explicitly selected extension tab; never extract another application's cookies.
- Use `npm run typecheck`, `npm test`, `npm run build` and `npm run test:mcp` for offline verification. `npm run test:live` performs read-only network checks and reports partial/blocked results truthfully.
- Live writes require an explicit enabled write setting and a prepared action. Never publish test content or change a real account just to pass a test.
- Missing engagement values stay null. A partial follower list cannot prove that a relationship does not exist. Never call observed page windows complete history.
- Search rankings must identify their method. Lexical fallback must not be presented as embedding-based semantic search.
- Project checkpoints belong in `docs/WORKLOG.md`.
