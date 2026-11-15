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
 */
export function mergeFsSpawnArgs(
  fsBridge: ClientBridge | undefined,
  fsExtraArgs: string[] | undefined,
  handoffExtras: SpawnExtras
): SpawnExtras {
  const env = { ...handoffExtras.env, ...(fsBridge?.env ?? {}) }
  const extraArgs = [...(handoffExtras.extraArgs ?? []), ...(fsExtraArgs ?? [])]
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
