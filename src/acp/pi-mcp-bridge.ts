/**
 * Mounts ACP session/new MCP servers inside pi without core changes.
 *
 * pi-acp spawns pi with `--extension <this file>` and PI_ACP_MCP_SERVERS_FILE set to
 * the absolute path of a 0600 temp file holding a JSON array of {name, config} in
 * mcp.json shape. Entries register during extension load, so the MCP extension connects
 * them on session_start like any later registration.
 *
 * pi swallows extension-load errors and keeps running, so the adapter validates the
 * handoff up front (toPiMcpHandoff) and refuses the session before spawning; this file
 * is a defensive backstop, not the primary guard. The temp file is unlinked in a
 * `finally` once read.
 *
 * No imports beyond node builtins: pi loads this file directly (jiti handles .ts, node
 * handles the bundled .js), so it must stay dependency-free.
 */

import { readFileSync, unlinkSync } from 'node:fs'

interface HandoffEntry {
  name?: unknown
  config?: unknown
}

interface BridgeApi {
  registerMcpServer(name: string, config: unknown): void
}

export default function (pi: BridgeApi): void {
  const filePath = process.env.PI_ACP_MCP_SERVERS_FILE
  if (filePath === undefined || filePath === '') return
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (e: any) {
    throw new Error(
      `PI_ACP_MCP_SERVERS_FILE is missing or unreadable (${filePath}): ${String(e?.message ?? e)}`
    )
  }
  try {
    let entries: unknown
    try {
      entries = JSON.parse(raw)
    } catch {
      throw new Error('PI_ACP_MCP_SERVERS_FILE is not valid JSON')
    }
    if (!Array.isArray(entries)) throw new Error('PI_ACP_MCP_SERVERS_FILE must be a JSON array')
    for (const entry of entries) {
      const candidate = entry as HandoffEntry
      if (typeof candidate?.name !== 'string' || candidate.name.length === 0) {
        throw new Error('PI_ACP_MCP_SERVERS_FILE entry needs a non-empty string name')
      }
      if (typeof candidate.config !== 'object' || candidate.config === null) {
        throw new Error(`PI_ACP_MCP_SERVERS_FILE entry "${candidate.name}" needs a config object`)
      }
      pi.registerMcpServer(candidate.name, {
        ...(candidate.config as Record<string, unknown>),
        // The ACP client explicitly requested these servers for this session, so expose
        // their tools directly to the model. pi's default exposure is 'codemode', which
        // hides them unless a codemode script searches for them.
        exposure: 'direct'
      })
    }
  } finally {
    try {
      unlinkSync(filePath)
    } catch {
      // best-effort; the file may already be gone
    }
  }
}