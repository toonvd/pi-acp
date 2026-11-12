import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVERS_FILE_ENV } from '../../src/acp/mcp-handoff.js'
import { SessionManager, type PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function writeFakePi(root: string): string {
  const fixture = join(root, 'fake-pi.cjs')
  writeFileSync(
    fixture,
    [
      "const { writeFileSync } = require('node:fs')",
      "writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv: process.argv, env: process.env }))",
      "// Stay alive until the adapter disposes us (SIGTERM).",
      "setInterval(() => {}, 1000)",
      "const readline = require('node:readline')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  const data = command.type === 'get_state' ? { sessionId: 'mcp-create-session', sessionFile: process.env.FAKE_PI_SESSION_FILE, thinkingLevel: 'medium', model: { provider: 'test', id: 'alpha' } } : {}",
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }) + '\\n')",
      '})'
    ].join('\n')
  )
  return fixture
}

function extensionPaths(argv: string[]): string[] {
  const paths: string[] = []
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--extension') paths.push(argv[i + 1])
  }
  return paths
}

test('SessionManager.create spawns pi with the bridge extension and a handoff env file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-create-'))
  writeFakePi(root)
  const launcher = join(root, 'pi')
  writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-pi.cjs')\n")
  chmodSync(launcher, 0o755)
  const logPath = join(root, 'spawn-log.json')
  const sessionFile = join(root, 'sessions', 'mcp-create-session.jsonl')
  const prevCmd = process.env.PI_ACP_PI_COMMAND
  const prevLog = process.env.FAKE_PI_LOG
  const prevSessionFile = process.env.FAKE_PI_SESSION_FILE
  const prevHome = process.env.HOME

  process.env.PI_ACP_PI_COMMAND = launcher
  process.env.FAKE_PI_LOG = logPath
  process.env.FAKE_PI_SESSION_FILE = sessionFile
  // Isolate SessionManager's internal SessionStore (paths.ts reads homedir()).
  process.env.HOME = join(root, 'home')

  let session: PiAcpSession | null = null
  try {
    const conn = new FakeAgentSideConnection()
    const sessions = new SessionManager()
    session = await sessions.create({
      cwd: root,
      mcpServers: [{ name: 'probe', command: '/bin/echo', args: ['hi'], env: [] }],
      conn: asAgentConn(conn),
      fileCommands: [],
      piCommand: launcher
    })

    assert.equal(session.sessionId, 'mcp-create-session')
    const log = JSON.parse(readFileSync(logPath, 'utf8'))
    assert.ok(log.argv.includes('--extension'), 'pi must be spawned with --extension')
    const bridgeArg = log.argv[log.argv.indexOf('--extension') + 1]
    assert.equal(existsSync(bridgeArg), true, 'the --extension argument must be a real bridge file')

    // The permission gate must be mounted ALONGSIDE the bridge.
    const extensions = extensionPaths(log.argv)
    assert.equal(extensions.length, 2, 'both bridge and gate extensions must be mounted')
    assert.ok(
      extensions.some(p => p.endsWith('pi-mcp-bridge.js') || p.endsWith('pi-mcp-bridge.ts')),
      'expected the MCP bridge extension'
    )
    assert.ok(
      extensions.some(p => p.endsWith('pi-permission-gate.js') || p.endsWith('pi-permission-gate.ts')),
      'expected the permission gate extension'
    )

    const filePath = log.env[MCP_SERVERS_FILE_ENV]
    assert.ok(filePath, 'pi must receive the handoff env file var')
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), [
      { name: 'probe', config: { command: '/bin/echo', args: ['hi'], env: {} } }
    ])
    assert.equal(log.env.PI_ACP_MCP_SERVERS, undefined, 'inline JSON env must be gone')
    assert.deepEqual(sessions.mcpServersFor('mcp-create-session'), [
      { name: 'probe', command: '/bin/echo', args: ['hi'], env: [] }
    ])
    rmSync(filePath, { force: true })
  } finally {
    session?.proc.dispose()
    if (prevCmd === undefined) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevCmd
    if (prevLog === undefined) delete process.env.FAKE_PI_LOG
    else process.env.FAKE_PI_LOG = prevLog
    if (prevSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE
    else process.env.FAKE_PI_SESSION_FILE = prevSessionFile
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionManager.create spawns pi with just the permission gate when no MCP servers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-gate-spawn-'))
  writeFakePi(root)
  const launcher = join(root, 'pi')
  writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-pi.cjs')\n")
  chmodSync(launcher, 0o755)
  const logPath = join(root, 'spawn-log.json')
  const sessionFile = join(root, 'sessions', 'gate-session.jsonl')
  const prevCmd = process.env.PI_ACP_PI_COMMAND
  const prevLog = process.env.FAKE_PI_LOG
  const prevSessionFile = process.env.FAKE_PI_SESSION_FILE
  const prevHome = process.env.HOME

  process.env.PI_ACP_PI_COMMAND = launcher
  process.env.FAKE_PI_LOG = logPath
  process.env.FAKE_PI_SESSION_FILE = sessionFile
  process.env.HOME = join(root, 'home')

  let session: PiAcpSession | null = null
  try {
    const sessions = new SessionManager()
    session = await sessions.create({
      cwd: root,
      mcpServers: [],
      conn: asAgentConn(new FakeAgentSideConnection()),
      fileCommands: [],
      piCommand: launcher
    })

    const log = JSON.parse(readFileSync(logPath, 'utf8'))
    const extensions = extensionPaths(log.argv)
    assert.equal(extensions.length, 1, 'only the gate extension when no MCP servers')
    assert.ok(
      extensions[0].endsWith('pi-permission-gate.js') || extensions[0].endsWith('pi-permission-gate.ts'),
      'expected the permission gate extension'
    )
    assert.equal(log.env[MCP_SERVERS_FILE_ENV], undefined)
  } finally {
    session?.proc.dispose()
    if (prevCmd === undefined) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevCmd
    if (prevLog === undefined) delete process.env.FAKE_PI_LOG
    else process.env.FAKE_PI_LOG = prevLog
    if (prevSessionFile === undefined) delete process.env.FAKE_PI_SESSION_FILE
    else process.env.FAKE_PI_SESSION_FILE = prevSessionFile
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionManager.create refuses invalid MCP servers before spawning', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new Error('should not spawn')
  }

  const invalidCases: any[][] = [
    [{ name: 'bad name!', command: 'x' }],
    [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }],
    [{ name: 's', command: '' }],
    [{ name: 'w', type: 'http', url: 'not a url' }],
    [{ name: 'stream', type: 'sse', url: 'https://example.com/sse' }]
  ]

  try {
    const sessions = new SessionManager()
    for (const mcpServers of invalidCases) {
      await assert.rejects(
        () =>
          sessions.create({
            cwd: process.cwd(),
            mcpServers,
            conn: {} as any,
            fileCommands: []
          }),
        (e: any) => e?.code === -32602
      )
    }
    assert.equal(spawnCount, 0)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})