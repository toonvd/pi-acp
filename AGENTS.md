# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps:

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- Do **not** implement ACP client-side FS/terminal delegation in MVP. Pi already reads/writes and executes locally.
- Ignore `mcpServers` for MVP (accept in params, store in session state).
- Stream all pi assistant output as ACP `agent_message_chunk` initially.
- Tool events: map pi tool execution events to ACP `tool_call` / `tool_call_update` (as text content).

## Dev workflow (to be filled once scaffold exists)

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Test: `npm run test`

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bashN
# Send initialize request via stdin (exact fields depend on ACP SDK version)
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!

## Client information

- Current ACP client is Zed

## References

- Local ACP repo with protocol documentation and specs: `~/Dev/learning/agent-client-protocol`
- Local Zed repo `~/Dev/learning/zed/zed`

## Working state (verified 2026-11-15, pi 1.3.0 + Zed 1.28.1)

### What the adapter emits today (proven with a headless ACP client)

`node scripts/e2e-acp.mjs` in the sibling `harness-wt` worktree drives the built adapter and asserts:

- **PASS diff** — a prompt that writes a file produces a client-side `fs/write_text_file`
  request (Zed applies it, so the Review Changes panel has something to show) plus a
  `tool_call_update` carrying `{type:'diff'}` content.
- **PASS subagent** — a `subagent` tool call reaches a terminal status; the card title is
  `subagent: scout — <task>`.
- **PASS replay** — `session/load` re-emits the edit as a `tool_call` with `locations` and a
  `diff` content block (commit b35e340).
- **SKIP plan** — there is no plan source. See below.

### Why the plan panel is empty

pi 1.3.0 has **no `todo` tool** (`dist/index.js` exports only bash/edit/find/grep/ls/powershell/
read/write tool definitions; the string `todo` does not appear in the bundle). Our
`todoDetailsToPlan` port (ee96e0f) is correct but can never fire.

The two reference forks populate the plan panel differently, and **neither transport exists in
pi 1.3.0**:

- `base-xik` — plan from a companion `todo` tool (same dead end), and subagent cards via
  `ctx.ui.setStatus('pi-acp:subagent', json)`.
- `base-geohar` — plan from its bundled pi extension, which subscribes to `pi.events`
  (`subagents:created|started|completed|failed|steered|compacted`, `plan:snapshot|update`) and
  forwards each as `pi.appendEntry('acp:subagents'|'acp:plan', …)`, crossing RPC as
  `entry_appended`.

Verified against the installed toolchain: pi 1.3.0 does not emit `entry_appended` (0 occurrences
in its bundle), and pi-subagents 0.79.2 does not emit the `subagents:*` bus events. It emits
`subagent:async-started|async-complete|foreground-complete|child-status|steering-notice|…`
instead. The only extension → adapter channel that does work on this stack is
`ctx.ui.setStatus(key, text)`, which arrives at the adapter as an `extension_ui_request` with
`method: 'setStatus'` — and `session.ts handleExtensionUiRequest` currently ignores it.

So the plan panel needs a **new** bridge, ported in shape from `base-xik`'s
`.ref/extensions-from-xik/pi-acp-subagents.ts` (398 lines): a bundled pi extension subscribes to
the `subagent:*` events, polls `<asyncDir>/status.json` for live step state, and emits one
`setStatus` snapshot per run; the adapter decodes those snapshots into `sessionUpdate: 'plan'`
entries (one entry per subagent run, status pending/in_progress/completed/failed). That gives the
plan panel a real source without inventing a `todo` tool and without touching subagent card
rendering.

### Environment gotchas that cost hours

- Zed keeps thread metadata in `~/Library/Application Support/Zed/db/0-stable/db.sqlite`
  (`sidebar_threads` table). `~/Library/Application Support/Zed/threads/threads.db` is a **stale
  pre-1.28 store** — do not assert against it.
- Zed refuses an isolated `--user-data-dir` launch while any instance runs (global single-instance
  lock), so a self-driving GUI harness cannot sandbox itself. A fresh project window also defaults
  to the Zed Agent sign-in panel, not `pi-acp`; the pi selection is remembered per workspace.
- Zed exposes no panel/editor text through macOS Accessibility. Screen capture + Vision OCR is the
  only rendered-text channel, and it needs the Screen Recording grant on `Zed.app`.
- `~/.pi/agent/settings.json` must stay valid JSON — an invalid file silently disables every
  installed package (including pi-subagents), which looks like "subagents stopped working".

### Subagent cards + Stop button (commit afb9084, 2026-11-16)

The "plan panel showing subagents" requirement is now met by **real ACP subagent cards**, not a
plan stream. Bundled `src/acp/pi-subagents-bridge.ts` runs inside pi, subscribes to
`subagent:async-started|async-complete|foreground-complete|child-status` and polls each async run's
`status.json` (500 ms, unref'd), republishing one JSON snapshot per run via the only working
extension → adapter channel: `ctx.ui.setStatus('pi-acp:subagent:<runId>', json)`.

The adapter (`session.ts handleExtensionStatus`) decodes each snapshot into:

- a parent-side `sessionUpdate:'subagent_update'` (`sessionId:'pi-subagent-<runId>'`, title,
  `capabilities:{cancel:{}}` while live) → Zed renders a subagent card **with a Stop button**;
- a child-session `agent_message_chunk` with only the text delta (so the card streams, not repeats).

Stop: Zed sends `session/cancel` with the child id; `agent.ts cancel()` routes
`pi-subagent-*` ids to the parent session's `SubagentBridge` control socket, and the extension
issues pi-subagents' own in-process RPC (`subagents:rpc:v1:request`, `method:'stop'`, `params:{id}`).

Key facts:

- Feature is capability-gated on the client advertising `subagents` (mirrors `fsWriteEnabled`
  gating the fs bridge). Zed advertises it only while its `acp-beta` flag is on (it is).
- SDK 0.26.0 has no `SubagentUpdate` type, so the update is emitted as a raw object; the activity
  `state` field is deliberately omitted (cannot build its tagged union) — cards render, live text
  streams, Stop works, but Zed shows no in-card activity spinner.
- Only async runs can be stopped; stopping a foreground run returns `success:false` from the RPC
  and is reported back over the socket without announcing a future cancel.
- 248/249 tests pass. The one failure (`session-fs-bridge.test.ts` "spawns no fs bridge when the
  client cannot write") is **pre-existing** — fails identically on `ee96e0f` baseline.
