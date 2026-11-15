/**
 * Routes pi file writes through the ACP client so Zed's review panel can preview every
 * mutation instead of applying it silently to the local disk.
 *
 * pi-acp spawns pi with `--extension <this file>` (bundled alongside the MCP bridge) and
 * PI_ACP_FS_SOCKET/PI_ACP_FS_CAPS set to the per-session client bridge. The write tool
 * tries the socket first and falls back to the local file when the client is unreachable,
 * so a session still makes progress without the bridge.
 *
 * The pi SDK stays an external import: pi's extension loader aliases
 * `@earendil-works/pi-coding-agent` to its own copy, so this file never needs the package
 * installed next to pi-acp.
 */

import { createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'

type Response = { id: string; error?: string }

class FsClient {
  private socket?: Socket
  private failed = false
  private readonly pending = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly path: string) {}

  close(error = new Error('Filesystem bridge closed')): void {
    this.failed = true
    this.socket?.destroy()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  request(op: 'writeTextFile', path: string, content: string): Promise<Response> {
    if (this.failed) return Promise.reject(new Error('Filesystem bridge unavailable'))
    if (!this.socket) {
      const socket = (this.socket = createConnection(this.path))
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          try {
            const response = JSON.parse(line) as Response
            const entry = this.pending.get(response.id)
            if (!entry) continue
            this.pending.delete(response.id)
            clearTimeout(entry.timer)
            if (typeof response.error === 'string') entry.reject(new Error(response.error))
            else entry.resolve(response)
          } catch {
            this.close(new Error('Invalid filesystem bridge response'))
            return
          }
        }
      })
      socket.on('error', error => this.close(error))
      socket.on('close', () => this.close())
    }
    const socket = this.socket
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Filesystem bridge request timed out'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, op, path, content }) + '\n', error => {
        if (error) this.close(error)
      })
    })
  }
}

export default function (pi: ExtensionAPI): void {
  const socketPath = process.env.PI_ACP_FS_SOCKET
  if (!socketPath) return
  const caps = new Set((process.env.PI_ACP_FS_CAPS ?? '').split(','))
  const client = new FsClient(socketPath)
  pi.on('session_shutdown', async () => client.close())

  const writeFile = async (path: string, content: string): Promise<void> => {
    try {
      if (!caps.has('write')) throw new Error('Client filesystem write unavailable')
      await client.request('writeTextFile', path, content)
    } catch {
      // The client socket may be gone (or never started); fall back to writing the
      // file locally so the session still makes progress.
      await fs.writeFile(path, content, 'utf8')
    }
  }

  const cwd = process.cwd()
  pi.registerTool(
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile,
        mkdir: async dir => {
          await fs.mkdir(dir, { recursive: true })
        }
      }
    })
  )
  // Edits are the mutation the review panel matters for most: the tool still matches
  // oldText against the on-disk file, but the resulting content is written by the client.
  pi.registerTool(
    createEditToolDefinition(cwd, {
      operations: {
        readFile: path => fs.readFile(path),
        writeFile,
        access: path => fs.access(path)
      }
    })
  )
}
