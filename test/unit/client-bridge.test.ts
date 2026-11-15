import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { ClientBridge, fsBridgePath, mergeFsSpawnArgs } from '../../src/acp/client-bridge.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function request(socketPath: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)))
    })
    socket.on('error', reject)
  })
}

test('ClientBridge: is not created when the client cannot write files', async () => {
  const conn = new FakeAgentSideConnection()
  assert.equal(await ClientBridge.create(asAgentConn(conn) as any, () => 's1', {}), undefined)
  assert.equal(await ClientBridge.create(asAgentConn(conn) as any, () => 's1', { write: false }), undefined)
})

test('ClientBridge: a writeTextFile request becomes an ACP client write', async () => {
  const conn = new FakeAgentSideConnection()
  const bridge = await ClientBridge.create(asAgentConn(conn) as any, () => 'session-1', { write: true })
  assert.ok(bridge)
  try {
    assert.equal(bridge.env.PI_ACP_FS_SOCKET, bridge.path)
    assert.equal(bridge.env.PI_ACP_FS_CAPS, 'write')

    const response = await request(bridge.path, {
      id: 'req-1',
      op: 'writeTextFile',
      path: '/tmp/project/a.ts',
      content: 'export const a = 1\n'
    })

    assert.deepEqual(response, { id: 'req-1' })
    assert.deepEqual(conn.writtenFiles, [
      { sessionId: 'session-1', path: '/tmp/project/a.ts', content: 'export const a = 1\n' }
    ])
  } finally {
    bridge.close()
  }
})

test('ClientBridge: a rejected client write is reported back to the extension', async () => {
  const conn = new FakeAgentSideConnection()
  conn.writeTextFileError = new Error('buffer is read-only')
  const bridge = await ClientBridge.create(asAgentConn(conn) as any, () => 'session-1', { write: true })
  assert.ok(bridge)
  try {
    const response = await request(bridge.path, {
      id: 'req-2',
      op: 'writeTextFile',
      path: '/tmp/project/a.ts',
      content: 'x'
    })
    assert.equal(response.id, 'req-2')
    assert.match(response.error, /read-only/)
  } finally {
    bridge.close()
  }
})

test('ClientBridge: relative paths and unknown operations are refused', async () => {
  const conn = new FakeAgentSideConnection()
  const bridge = await ClientBridge.create(asAgentConn(conn) as any, () => 'session-1', { write: true })
  assert.ok(bridge)
  try {
    const relative = await request(bridge.path, {
      id: 'req-3',
      op: 'writeTextFile',
      path: 'a.ts',
      content: 'x'
    })
    assert.match(relative.error, /absolute/)

    const unknown = await request(bridge.path, { id: 'req-4', op: 'readTextFile', path: '/tmp/a.ts' })
    assert.match(unknown.error, /Unsupported/)

    assert.equal(conn.writtenFiles.length, 0)
  } finally {
    bridge.close()
  }
})

test('ClientBridge: close removes the socket directory', async () => {
  const conn = new FakeAgentSideConnection()
  const bridge = await ClientBridge.create(asAgentConn(conn) as any, () => 'session-1', { write: true })
  assert.ok(bridge)
  assert.equal(existsSync(bridge.path), true)
  bridge.close()
  assert.equal(existsSync(bridge.path), false)
})

test('mergeFsSpawnArgs: keeps both --extension pairs and merges env without overwriting', () => {
  const merged = mergeFsSpawnArgs(
    { env: { PI_ACP_FS_SOCKET: '/tmp/sock', PI_ACP_FS_CAPS: 'write' } } as unknown as ClientBridge,
    ['--extension', '/dist/acp/pi-fs-bridge.js'],
    {
      env: { PI_ACP_MCP_SERVERS_FILE: '/tmp/mcp.json' },
      extraArgs: ['--extension', '/dist/acp/pi-mcp-bridge.js'],
      discard: () => {}
    }
  )

  assert.deepEqual(merged.env, {
    PI_ACP_MCP_SERVERS_FILE: '/tmp/mcp.json',
    PI_ACP_FS_SOCKET: '/tmp/sock',
    PI_ACP_FS_CAPS: 'write'
  })
  assert.deepEqual(merged.extraArgs, [
    '--extension',
    '/dist/acp/pi-mcp-bridge.js',
    '--extension',
    '/dist/acp/pi-fs-bridge.js'
  ])
  assert.equal(typeof merged.discard, 'function')
})

test('fsBridgePath: resolves the bundled extension next to the adapter sources', () => {
  const path = fsBridgePath()
  assert.match(path, /pi-fs-bridge\.(ts|js)$/)
  assert.equal(existsSync(path), true)
})
