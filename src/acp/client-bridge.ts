import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ClientCapabilities = { write?: boolean }
export type BridgeConnection = Pick<AgentSideConnection, 'writeTextFile'>

type BridgeRequest = {
  id?: unknown
  op?: unknown
  path?: unknown
  content?: unknown
}

type BridgeMessage = { id: string | null; error?: string }

/**
 * Per-session IPC bridge that lets the pi fs extension delegate file writes to the
 * ACP client, so Zed's review panel can preview every mutation. Protocol:
 * newline-delimited JSON over a local socket; each request is answered with
 * `{ id }` (or `{ id, error }`) once the client confirms the write.
 */
export class ClientBridge {
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer(socket => this.accept(socket))
  private closed = false
  private readonly directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'pi-acp-'))
  readonly path = this.directory ? join(this.directory, 'bridge.sock') : `\\\\.\\pipe\\pi-acp-${randomUUID()}`

  private constructor(
    private readonly conn: BridgeConnection,
    private readonly sessionId: () => string,
    private readonly caps: ClientCapabilities
  ) {}

  static async create(
    conn: BridgeConnection,
    sessionId: () => string,
    caps: ClientCapabilities = {}
  ): Promise<ClientBridge | undefined> {
    if (!caps.write) return undefined
    const bridge = new ClientBridge(conn, sessionId, caps)
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.server.once('error', reject)
        bridge.server.listen(bridge.path, () => {
          bridge.server.off('error', reject)
          resolve()
        })
      })
      bridge.server.on('error', () => bridge.close())
      return bridge
    } catch (error) {
      bridge.close()
      throw error
    }
  }

  get env(): Record<string, string> {
    return {
      // Env names are kept for compatibility with already installed pi-acp-fs extensions.
      PI_ACP_FS_SOCKET: this.path,
      PI_ACP_FS_CAPS: this.caps.write ? 'write' : ''
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.sockets.delete(socket)
    })
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) void this.respond(socket, line)
      }
    })
  }

  private send(socket: Socket, message: BridgeMessage): void {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n')
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let id: string | null = null
    try {
      const request = JSON.parse(line) as BridgeRequest | null
      if (typeof request?.id !== 'string') throw new Error('Invalid request id')
      id = request.id
      const sessionId = this.sessionId()
      if (!sessionId) throw new Error('Session is not ready')
      if (request.op === 'writeTextFile' && this.caps.write && typeof request.content === 'string') {
        await this.conn.writeTextFile({ sessionId, path: this.absolutePath(request.path), content: request.content })
        this.send(socket, { id })
      } else {
        throw new Error('Unsupported bridge operation or capability')
      }
    } catch (error) {
      this.send(socket, { id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private absolutePath(value: unknown): string {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Expected absolute path')
    return value
  }
}

type SpawnExtras = { env?: Record<string, string>; extraArgs?: string[]; discard?: () => void }

/**
 * Combine the FS bridge spawn additions with the MCP handoff ones. Both bridges are
 * bundled `--extension` files loaded by pi, so their `--extension` pairs are
 * concatenated and their env objects merged (never overwriting each other).
 *
 * The subagent snapshot extension is always loaded so every client can surface the fleet in the
 * plan panel; the `PI_ACP_SUBAGENT_SOCKET` control env is only added when a control socket
 * exists (`subagentsBridge`), i.e. when the client advertised the subagents capability.
 */
export function mergeFsSpawnArgs(
  fsBridge: ClientBridge | undefined,
  fsExtraArgs: string[] | undefined,
  handoffExtras: SpawnExtras,
  subagentsBridge?: SubagentBridge
): SpawnExtras {
  const env = { ...handoffExtras.env, ...(fsBridge?.env ?? {}), ...(subagentsBridge?.env ?? {}) }
  const extraArgs = [
    ...(handoffExtras.extraArgs ?? []),
    ...(fsExtraArgs ?? []),
    '--extension',
    subagentsBridgePath()
  ]
  const merged: SpawnExtras = {}
  if (Object.keys(env).length > 0) merged.env = env
  if (extraArgs.length > 0) merged.extraArgs = extraArgs
  if (handoffExtras.discard) merged.discard = handoffExtras.discard
  return merged
}

/** Absolute path of the bundled fs bridge extension, in dist/ and src/ layouts. */
export function fsBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'pi-fs-bridge.js'),
    join(here, 'acp', 'pi-fs-bridge.js'),
    join(here, 'pi-fs-bridge.ts')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw RequestError.internalError({}, 'Bundled fs bridge extension not found alongside pi-acp')
}

/**
 * Per-session control channel for the bundled pi-subagents bridge. The adapter asks the
 * extension to stop a run; the extension answers once pi-subagents' own RPC replies.
 * Protocol: newline-delimited JSON, `{op:'cancel', runId}` out, `{runId, ok, error?}` back.
 */
export class SubagentBridge {
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer(socket => this.accept(socket))
  private readonly pending = new Map<string, (result: SubagentCancelResult) => void>()
  private closed = false
  private readonly directory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'pi-acp-sub-'))
  readonly path = this.directory ? join(this.directory, 'subagents.sock') : `\\\\.\\pipe\\pi-acp-sub-${randomUUID()}`

  private constructor() {}

  static async create(): Promise<SubagentBridge | undefined> {
    const bridge = new SubagentBridge()
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.server.once('error', reject)
        bridge.server.listen(bridge.path, () => {
          bridge.server.off('error', reject)
          resolve()
        })
      })
      bridge.server.on('error', () => bridge.close())
      return bridge
    } catch {
      bridge.close()
      return undefined
    }
  }

  get env(): Record<string, string> {
    return { PI_ACP_SUBAGENT_SOCKET: this.path }
  }

  /** Ask the extension to stop a run. Resolves `{ok:false}` when it cannot. */
  cancel(runId: string, timeoutMs = 15_000): Promise<SubagentCancelResult> {
    const socket = [...this.sockets][0]
    if (this.closed || !socket) return Promise.resolve({ ok: false, error: 'Subagent bridge unavailable' })
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(runId)
        resolve({ ok: false, error: 'Subagent cancel timed out' })
      }, timeoutMs)
      this.pending.set(runId, result => {
        clearTimeout(timer)
        resolve(result)
      })
      socket.write(JSON.stringify({ op: 'cancel', runId }) + '\n')
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    for (const resolve of this.pending.values()) resolve({ ok: false, error: 'Subagent bridge closed' })
    this.pending.clear()
    this.server.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      this.sockets.delete(socket)
    })
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as { runId?: unknown; ok?: unknown; error?: unknown }
          const runId = typeof message.runId === 'string' ? message.runId : ''
          const resolve = this.pending.get(runId)
          if (!resolve) continue
          this.pending.delete(runId)
          resolve({
            ok: message.ok === true,
            ...(typeof message.error === 'string' ? { error: message.error } : {})
          })
        } catch {
          /* ignore malformed replies */
        }
      }
    })
  }
}

export type SubagentCancelResult = { ok: boolean; error?: string }

/** Absolute path of the bundled pi-subagents bridge extension, in dist/ and src/ layouts. */
export function subagentsBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'pi-subagents-bridge.js'),
    join(here, 'acp', 'pi-subagents-bridge.js'),
    join(here, 'pi-subagents-bridge.ts')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw RequestError.internalError({}, 'Bundled pi-subagents bridge extension not found alongside pi-acp')
}
