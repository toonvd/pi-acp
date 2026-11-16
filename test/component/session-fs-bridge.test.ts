import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientBridge, fsBridgePath } from '../../src/acp/client-bridge.js'
import { SessionManager, type PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function writeFakePi(root: string): string {
  const fixture = join(root, 'fake-pi.cjs')
  writeFileSync(
    fixture,
    [
      "const { writeFileSync } = require('node:fs')",
      'writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv: process.argv, env: process.env }))',
      'setInterval(() => {}, 1000)',
      "const readline = require('node:readline')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  const data = command.type === 'get_state' ? { sessionId: 'fs-create-session', sessionFile: process.env.FAKE_PI_SESSION_FILE, thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha' } } : {}",
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }) + '\\n')",
      '})'
    ].join('\n')
  )
  const launcher = join(root, 'pi')
  writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-pi.cjs')\n")
  chmodSync(launcher, 0o755)
  return launcher
}

type Harness = {
  root: string
  launcher: string
  logPath: string
  restore: () => void
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fs-bridge-'))
  const launcher = writeFakePi(root)
  const logPath = join(root, 'spawn-log.json')
  const previous = {
    cmd: process.env.PI_ACP_PI_COMMAND,
    log: process.env.FAKE_PI_LOG,
    sessionFile: process.env.FAKE_PI_SESSION_FILE,
    home: process.env.HOME,
    fsSocket: process.env.PI_ACP_FS_SOCKET,
    fsCaps: process.env.PI_ACP_FS_CAPS,
    subagentsSocket: process.env.PI_ACP_SUBAGENT_SOCKET
  }
  process.env.PI_ACP_PI_COMMAND = launcher
  process.env.FAKE_PI_LOG = logPath
  process.env.FAKE_PI_SESSION_FILE = join(root, 'sessions', 'fs-create-session.jsonl')
  // The adapter never carries bridge env vars in its own process; clear any that leaked from
  // the runner's shell so the child sees only what the adapter explicitly passes per-spawn.
  delete process.env.PI_ACP_FS_SOCKET
  delete process.env.PI_ACP_FS_CAPS
  delete process.env.PI_ACP_SUBAGENT_SOCKET
  // Isolate SessionManager's SessionStore (paths.ts reads homedir()).
  process.env.HOME = join(root, 'home')

  return {
    root,
    launcher,
    logPath,
    restore: () => {
      for (const [key, env] of [
        ['PI_ACP_PI_COMMAND', previous.cmd],
        ['FAKE_PI_LOG', previous.log],
        ['FAKE_PI_SESSION_FILE', previous.sessionFile],
        ['HOME', previous.home],
        ['PI_ACP_FS_SOCKET', previous.fsSocket],
        ['PI_ACP_FS_CAPS', previous.fsCaps],
        ['PI_ACP_SUBAGENT_SOCKET', previous.subagentsSocket]
      ] as const) {
        if (env === undefined) delete process.env[key]
        else process.env[key] = env
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('SessionManager.create passes the fs bridge env and both --extension args', async () => {
  const h = harness()
  let session: PiAcpSession | null = null
  let bridge: ClientBridge | undefined
  const conn = new FakeAgentSideConnection()
  const sessions = new SessionManager()
  try {
    bridge = await ClientBridge.create(asAgentConn(conn) as any, () => 'fs-create-session', { write: true })
    assert.ok(bridge)

    session = await sessions.create({
      cwd: h.root,
      mcpServers: [{ name: 'probe', command: '/bin/echo', args: ['hi'], env: [] }],
      conn: asAgentConn(conn),
      fileCommands: [],
      piCommand: h.launcher,
      fsBridge: bridge,
      fsExtraArgs: ['--extension', fsBridgePath()]
    })

    const log = JSON.parse(readFileSync(h.logPath, 'utf8'))
    assert.equal(log.env.PI_ACP_FS_SOCKET, bridge.path)
    assert.equal(log.env.PI_ACP_FS_CAPS, 'write')

    const extensions: string[] = []
    for (let i = 0; i < log.argv.length; i += 1) {
      if (log.argv[i] === '--extension') extensions.push(log.argv[i + 1])
    }
    assert.equal(extensions.length, 3, 'the MCP, fs and subagents bridges must be loaded')
    assert.ok(extensions.some(p => p.endsWith('pi-mcp-bridge.js') || p.endsWith('pi-mcp-bridge.ts')))
    assert.ok(extensions.some(p => p.endsWith('pi-fs-bridge.js') || p.endsWith('pi-fs-bridge.ts')))
    assert.ok(
      extensions.some(p => p.endsWith('pi-subagents-bridge.js') || p.endsWith('pi-subagents-bridge.ts'))
    )
    assert.equal(existsSync(bridge.path), true)

    const socketPath = bridge.path
    sessions.close('fs-create-session')
    session = null
    assert.equal(existsSync(socketPath), false, 'closing the session must remove the bridge socket')
  } finally {
    session?.proc.dispose()
    bridge?.close()
    h.restore()
  }
})

test('SessionManager.create spawns no fs bridge when the client cannot write', async () => {
  const h = harness()
  let session: PiAcpSession | null = null
  const conn = new FakeAgentSideConnection()
  const sessions = new SessionManager()
  try {
    session = await sessions.create({
      cwd: h.root,
      mcpServers: [],
      conn: asAgentConn(conn),
      fileCommands: [],
      piCommand: h.launcher
    })

    const log = JSON.parse(readFileSync(h.logPath, 'utf8'))
    assert.equal(log.env.PI_ACP_FS_SOCKET, undefined)
    assert.equal(log.env.PI_ACP_FS_CAPS, undefined)
    assert.equal(log.env.PI_ACP_SUBAGENT_SOCKET, undefined)
    // The subagent snapshot extension still loads (for the plan fleet); no fs bridge is loaded.
    assert.equal(log.argv.includes('--extension'), true)
    const extensions: string[] = []
    for (let i = 0; i < log.argv.length; i += 1) {
      if (log.argv[i] === '--extension') extensions.push(log.argv[i + 1])
    }
    assert.equal(
      extensions.some(p => p.endsWith('pi-fs-bridge.js') || p.endsWith('pi-fs-bridge.ts')),
      false,
      'no fs bridge when the client cannot write'
    )
  } finally {
    session?.proc.dispose()
    h.restore()
  }
})
