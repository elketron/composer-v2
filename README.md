# Composer v2

The board and pipeline layer over the [opencode](https://opencode.ai) agent
runtime. Composer v2 is not an agent runtime: pipeline `agent` steps launch
opencode with a named agent loaded (shipped as editable files in each
project), and composer observes the session (live deltas, transcripts) and
gates it (approval steps). The domain core — cards, lanes, sub-state,
validation with typed rejections — and the event backbone (append-only event
log, one write path, in-memory fold, SSE snapshot-then-live) are inherited
from composer v1 under the same wire contract, so the Angular desktop
connects unchanged.

- Stack: TypeScript (Node 22+, ESM), embedded SurrealDB (`@surrealdb/node`,
  RocksDB), hono. One server process, many projects.
- Layout: pnpm workspaces — `server/` (the API) and `desktop/` (Electron +
  Angular, moved from v1).
- Gate: `pnpm verify` (build + server tests + desktop specs). No real LLM in
  tests; agent calls run against a scripted fake engine.

Slices: S0 skeleton + wire + desktop · S1 domain core · S2 planning turn ·
S3 pipelines + opencode engine · S4 desktop completion.
