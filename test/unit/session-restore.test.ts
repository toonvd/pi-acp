import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { MCP_SERVERS_FILE_ENV, permissionGatePath } from '../../src/acp/mcp-handoff.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  restoredSession: any = null

  constructor(private readonly buildSession: (sessionId: string, params: any) => any) {}

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId ? this.restoredSession : undefined
  }

  getOrCreate(sessionId: string, params: any) {
    if (!this.restoredSession) {
      this.restoredSession = this.buildSession(sessionId, params)
    }
    return this.restoredSession
  }

  mcpServersFor() {
    return undefined
  }
}

test('PiAcpAgent: prompt auto-restores a missing session from SessionStore', async () => {
  const conn = new FakeAgentSideConnection()
  const promptCalls: Array<{ message: string; images: unknown[] }> = []
  const spawnCalls: any[] = []
  const storeUpserts: any[] = []

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async prompt(message: string, images: unknown[]) {
      promptCalls.push({ message, images })
      return 'end_turn'
    },
    async cancel() {},
    wasCancelRequested() {
      return false
    }
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'stored-session') return null
        return {
          sessionId,
          cwd: '/tmp/store-project',
          sessionFile: '/tmp/store-project/session.jsonl',
          updatedAt: new Date().toISOString()
        }
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'hello again' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/store-project',
        sessionPath: '/tmp/store-project/session.jsonl',
        piCommand: process.env.PI_ACP_PI_COMMAND,
        extraArgs: ['--extension', permissionGatePath()]
      }
    ])
    assert.deepEqual(promptCalls, [{ message: 'hello again', images: [] }])
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'stored-session',
        cwd: '/tmp/store-project',
        sessionFile: '/tmp/store-project/session.jsonl'
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: setSessionConfigOption auto-restores via pi session discovery when SessionStore misses', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-restore-fallback-'))
  const sessionsDir = join(root, 'sessions', '--tmp--fallback-project--')
  const sessionFile = join(sessionsDir, '0000_restore_fallback.jsonl')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'fallback-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/fallback-project'
    }) + '\n',
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = root

  const storeUpserts: any[] = []
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  const spawnCalls: any[] = []
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async publishContextUsage() {
      // Context usage publishing is covered in test/unit/context-usage.test.ts.
    }
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      getAvailableThinkingLevels: async () => ['medium'],
      getAvailableModels: async () => ({
        models: [
          { provider: 'test', id: 'alpha', name: 'Alpha' },
          { provider: 'test', id: 'beta', name: 'Beta' }
        ]
      }),
      getState: async () => state,
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get() {
        return null
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.setSessionConfigOption({
      sessionId: 'fallback-session',
      configId: 'model',
      value: 'test/beta'
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/fallback-project',
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        extraArgs: ['--extension', permissionGatePath()]
      }
    ])
    assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
    assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      },
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      }
    ])
    assert.deepEqual(conn.updates, [
      { sessionId: 'fallback-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'medium' } },
      {
        sessionId: 'fallback-session',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: restoreSession re-mounts remembered MCP servers after close', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-restore-mcp-'))
  const sessionFile = join(root, 'session.jsonl')

  const makeProc = () => {
    let handler: ((ev: any) => void) | null = null
    return {
      onEvent(h: (ev: any) => void) {
        handler = h
        return () => {
          handler = null
        }
      },
      async prompt() {
        // Simulate pi settling so the ACP session/prompt resolves.
        handler?.({ type: 'agent_settled' })
      },
      async getState() {
        return {
          sessionId: 'mcp-restore',
          sessionFile,
          thinkingLevel: 'medium',
          model: { provider: 'test', id: 'alpha' }
        }
      },
      async getAvailableModels() {
        return { models: [] }
      },
      async getAvailableThinkingLevels() {
        return ['medium']
      },
      async getSessionStats() {
        return {}
      }
    } as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return makeProc()
  }

  const handoffFilePath = join(root, 'handoff.json')
  try {
    const sessions = new SessionManager()
    // Mount servers and register the session (simulates session/new), then close it
    // (simulates a chat switch): the servers must survive for the respawn.
    sessions.getOrCreate('mcp-restore', {
      cwd: root,
      mcpServers: [{ name: 'probe', command: '/bin/echo', args: ['hi'], env: [] }],
      conn: asAgentConn(conn),
      proc: makeProc(),
      fileCommands: []
    } as any)
    sessions.close('mcp-restore')

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(id: string) {
        if (id !== 'mcp-restore') return null
        return { sessionId: id, cwd: root, sessionFile, updatedAt: new Date().toISOString() }
      },
      upsert() {}
    }

    const result = await agent.prompt({
      sessionId: 'mcp-restore',
      prompt: [{ type: 'text', text: 'hello again' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    // The respawn from restoreSession must carry the remembered servers.
    const restoreSpawn = spawnCalls[spawnCalls.length - 1]
    assert.equal(restoreSpawn.extraArgs?.[0], '--extension')
    const filePath = restoreSpawn.env?.[MCP_SERVERS_FILE_ENV]
    assert.ok(filePath, 'restoreSession spawn must set the handoff env file')
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), [
      { name: 'probe', config: { command: '/bin/echo', args: ['hi'], env: {} } }
    ])
    // Servers are still remembered for the next respawn.
    assert.deepEqual(sessions.mcpServersFor('mcp-restore'), [
      { name: 'probe', command: '/bin/echo', args: ['hi'], env: [] }
    ])
    rmSync(filePath, { force: true })
  } finally {
    PiRpcProcess.spawn = originalSpawn
    rmSync(handoffFilePath, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: cancel ignores stale session IDs without spawning a restore process', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(() => {
      throw new Error('cancel should not restore a missing session')
    }) as any

    await agent.cancel({ sessionId: 'stale-session' } as any)

    assert.deepEqual(spawnCalls, [])
    assert.deepEqual(conn.updates, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
