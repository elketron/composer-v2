# Pi engine migration

## Decision

Composer should migrate its agent runtime from OpenCode to Pi by embedding the
Pi coding-agent SDK behind Composer's existing `AgentEngine` interface.

Use `@earendil-works/pi-coding-agent`, backed by
`@earendil-works/pi-agent-core`, rather than building directly on agent-core.
The coding-agent layer already supplies filesystem and shell tools, session
management, compaction, retries, model discovery, and credential handling.
Building on agent-core alone would make Composer responsible for all of those
facilities.

The migration should not change Composer's durable domain model or desktop
wire protocol. Pi events will be translated to the existing normalized
`AgentTurnEvent` values just as OpenCode events are today.

## Why the migration is contained

Runtime-specific behavior is already isolated behind
`server/src/engine/types.ts`. Planning, assistant, and pipeline orchestration
depend on the generic `AgentEngine` contract, while the event store and desktop
persist and render Composer-owned messages, tool calls, usage, files, and
statuses.

The main OpenCode-specific surface is:

- `server/src/engine/serve.ts`
- `server/src/engine/serve-client.ts`
- `server/src/engine/serve-process.ts`
- `server/src/engine/opencode.ts`
- `server/src/models.ts`
- `server/src/agents/ship.ts`
- OpenCode adapter tests and product copy

This is roughly 1,000 lines of production runtime adapter code and 300 lines of
direct adapter tests. Most Angular views and server orchestration should not
need structural changes.

## Target design

Add a `PiEngine` that implements `AgentEngine` and owns an in-process Pi
session for each active Composer session.

The adapter will:

1. Resolve the configured `provider/model` through Pi's `ModelRuntime`.
2. Build a Pi session for the requested agent and project directory.
3. Translate Pi message, tool, usage, and lifecycle events to
   `AgentTurnEvent`.
4. Abort the Pi session when Composer's signal or turn timeout fires.
5. Retain the Pi session for conversational continuity and dispose it when
   `releaseSession` or `close` is called.
6. Calculate Git changes around a turn so shell-created files are reported in
   addition to native edit/write results.

Production boot should remain on OpenCode until the Pi adapter passes parity
and packaging checks. The first implementation is an opt-in/tested seam, not a
runtime cutover.

## Composer tools

Pi deliberately does not provide MCP as a built-in facility. Composer should
therefore expose its existing validated tool surfaces as Pi custom tools rather
than preserve the OpenCode-to-MCP-child process chain.

The custom tools can call the same Composer HTTP routes used by the current MCP
children:

- Planner: `/mcp/command`
- Worker agents: `/mcp/worker`
- Global assistant: `/mcp/read`

This preserves server-side scope and command validation. It also removes MCP
process supervision and OpenCode's tool-name prefixing. Agent prompts must be
updated to use the final Pi tool names.

## Agent definitions and permissions

OpenCode frontmatter under `.opencode/agent/` becomes explicit Pi session
configuration:

- The Markdown body becomes the system prompt.
- Coder and tester receive the required Pi coding tools.
- Reviewer and security receive read-only tools.
- Assistant receives only Composer custom tools.
- Planner receives a path-restricted plan editing tool plus ticket creation.

Planner protection must remain an executable security boundary. A prompt that
says "only edit plan.md" is not sufficient; disallowed paths must be blocked by
tool construction or `beforeToolCall`.

## Models and credentials

Replace `opencode models` with Pi's `ModelRuntime` catalog. Composer can keep
persisting opaque `provider/model` strings, so the desktop settings model does
not require a schema change.

OpenCode currently owns provider authentication. The cutover must choose one
of these approaches:

1. Adopt Pi's credential store and add Composer provider login/status UI.
2. Initially support environment credentials only, then add stored credentials.

The first adapter spike may use an injected session factory and does not need
to settle credential UX.

## Sessions and recovery

Composer runtime session IDs are currently held in memory. Worker retries also
do not consistently reuse the recorded engine session despite earlier product
documentation suggesting they do.

The Pi cutover should explicitly define:

- Whether Pi's JSONL sessions or Composer's event log owns conversational
  recovery.
- How a Composer session maps to a Pi session ID or session file.
- Whether pipeline retries resume context or deliberately start fresh.
- How stale sessions are detected after server restart.

This is a correctness improvement, not merely a vendor translation.

## Packaging

The server is currently emitted as one esbuild ESM bundle. Pi includes dynamic
provider and resource loading, so an early packaged-Electron spike is required.
The maintained Pi packages currently require Node 22.19 or newer; Composer's
declared server engine range must be tightened if that remains true at cutover.

## Estimate

| Work                                            |                  Estimate |
| ----------------------------------------------- | ------------------------: |
| Pi engine spike with streaming and cancellation |                  1-2 days |
| Production session pooling and continuity       |                  2-3 days |
| Composer custom-tool adapters                   |                  2-3 days |
| Agent prompt and permission translation         |                  1-2 days |
| Model and credential integration                |                  1-3 days |
| File tracking, packaging, tests, and cleanup    |                  2-3 days |
| **Total**                                       | **8-14 engineering days** |

A focused proof of concept should take 2-4 days. A production migration should
take approximately 2-3 weeks for one engineer. Using agent-core without the
coding-agent SDK would likely expand the work to 3-5 weeks.

## Delivery gates

1. Implement a `PiEngine` adapter with injected Pi sessions and prove text
   streaming, tool events, usage, cancellation, and disposal in unit tests.
2. Run one real coder turn through the SDK and verify Git file observations.
3. Verify the server bundle and packaged Electron application on supported
   platforms.
4. Convert Composer custom tools and agent permissions.
5. Replace model discovery and credential handling.
6. Switch production boot to Pi, remove OpenCode adapters, and update product
   copy only after parity tests pass.
