import { RequestError, type McpServer } from '@agentclientprotocol/sdk'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

/** Env var carrying the absolute path of the session/new MCP handoff temp file. */
export const MCP_SERVERS_FILE_ENV = 'PI_ACP_MCP_SERVERS_FILE'

/**
 * The handoff no longer rides the child env block: env is visible to the whole process
 * tree and Windows/Linux cap env block sizes. Secrets travel in a 0600 temp file; this
 * is a sane ceiling for a single session/new handoff regardless of transport.
 */
const MAX_HANDOFF_BYTES = 64 * 1024

/** pi's registerMcpServer name rule; mirrored so a bad name refuses the session here. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/

export interface McpHandoffEntry {
  name: string
  config: Record<string, unknown>
}

// ACP session/new elements carry stdio {command, args, env} or HTTP {url, headers}.
// pi serves those two transports; SSE and ACP-transport elements have nowhere to
// mount, so they refuse the session instead of running one whose tools never arrive.
//
// pi's registerMcpServer() validates names/URLs/namespaces during extension load, but
// pi swallows extension-load errors and keeps running, so a single bad element would
// silently drop ALL servers. Validate up front (mirroring pi's checks) and refuse the
// session before spawning.
export function toPiMcpHandoff(servers: McpServer[]): McpHandoffEntry[] {
  const entries: McpHandoffEntry[] = []
  const seenNames = new Set<string>()
  // pi maps each server to namespace `mcp__<name>` with `-` replaced by `_`, so names
  // that differ only in `-`/`_` collide in the same namespace.
  const namespaceOwners = new Map<string, string>()

  for (const server of servers) {
    const name = server.name
    if (typeof name !== 'string' || name.length === 0) {
      throw RequestError.invalidParams({}, 'MCP server name must be a non-empty string')
    }
    if (!SERVER_NAME_RE.test(name)) {
      throw RequestError.invalidParams(
        {},
        `MCP server name "${name}" contains invalid characters (allowed: A-Z a-z 0-9 _ -)`
      )
    }
    if (seenNames.has(name)) {
      throw RequestError.invalidParams({}, `Duplicate MCP server name "${name}" on session/new`)
    }
    const namespace = name.replace(/-/g, '_')
    const clashOwner = namespaceOwners.get(namespace)
    if (clashOwner !== undefined) {
      throw RequestError.invalidParams(
        {},
        `MCP server name "${name}" collides with "${clashOwner}": both map to pi namespace mcp__${namespace}`
      )
    }
    seenNames.add(name)
    namespaceOwners.set(namespace, name)

    if ('command' in server) {
      if (typeof server.command !== 'string' || server.command.length === 0) {
        throw RequestError.invalidParams({}, `MCP server "${name}" needs a non-empty command`)
      }
      const env: Record<string, string> = {}
      for (const entry of server.env ?? []) env[entry.name] = entry.value
      entries.push({ name, config: { command: server.command, args: server.args ?? [], env } })
    } else if (server.type === 'http') {
      if (!parseHttpUrl(server.url)) {
        throw RequestError.invalidParams({}, `MCP server "${name}" needs an http or https url`)
      }
      const headers: Record<string, string> = {}
      for (const entry of server.headers ?? []) headers[entry.name] = entry.value
      entries.push({ name, config: { type: 'http', url: server.url, headers } })
    } else {
      throw RequestError.invalidParams(
        {},
        `Unsupported MCP server "${server.name}" on session/new: pi serves stdio and HTTP transports only`
      )
    }
  }

  const raw = JSON.stringify(entries)
  if (Buffer.byteLength(raw, 'utf8') > MAX_HANDOFF_BYTES) {
    throw RequestError.invalidParams(
      {},
      `MCP handoff too large (${Buffer.byteLength(raw, 'utf8')} bytes, cap ${MAX_HANDOFF_BYTES})`
    )
  }
  return entries
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Spawn additions mounting the handoff, or {} when there is nothing to mount. */
export function handoffSpawnArgs(servers: McpServer[]): {
  env?: Record<string, string>
  extraArgs?: string[]
} {
  const entries = toPiMcpHandoff(servers)
  if (entries.length === 0) return {}
  // Secrets (headers/env) go in a 0600 temp file, not the child env block: env is
  // visible to the whole process tree and is size-limited on Windows/Linux. If pi fails
  // to spawn, the file is left behind — acceptable (rare, and no worse than an env leak).
  const filePath = join(tmpdir(), `pi-acp-mcp-${randomUUID()}.json`)
  writeFileSync(filePath, JSON.stringify(entries), { mode: 0o600 })
  return {
    env: { [MCP_SERVERS_FILE_ENV]: filePath },
    extraArgs: ['--extension', mcpBridgePath()]
  }
}

/** Absolute path of the bundled bridge extension, in dist/ and src/ layouts. */
export function mcpBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'pi-mcp-bridge.js'),
    join(here, 'acp', 'pi-mcp-bridge.js'),
    join(here, 'pi-mcp-bridge.ts')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw RequestError.internalError({}, 'Bundled MCP bridge extension not found alongside pi-acp')
}
