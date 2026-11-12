import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bridge from '../../src/acp/pi-mcp-bridge.js'
import {
  MCP_SERVERS_FILE_ENV,
  handoffSpawnArgs,
  mcpBridgePath,
  toPiMcpHandoff
} from '../../src/acp/mcp-handoff.js'

// pi#11067 companion, extension-bridge shape: the session/new array travels as a
// 0600 temp file into a bundled --extension instead of a core RPC command.

function withHandoffFile(raw: string, fn: (filePath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-handoff-'))
  const filePath = join(root, 'handoff.json')
  writeFileSync(filePath, raw, { mode: 0o600 })
  const saved = process.env[MCP_SERVERS_FILE_ENV]
  process.env[MCP_SERVERS_FILE_ENV] = filePath
  try {
    fn(filePath)
  } finally {
    if (saved === undefined) delete process.env[MCP_SERVERS_FILE_ENV]
    else process.env[MCP_SERVERS_FILE_ENV] = saved
    rmSync(root, { recursive: true, force: true })
  }
}

test('toPiMcpHandoff translates stdio and HTTP elements', () => {
  assert.deepEqual(
    toPiMcpHandoff([
      { name: 'probe', command: '/bin/echo', args: ['hi'], env: [{ name: 'A', value: 'b' }] },
      { name: 'web', type: 'http', url: 'https://example.com/mcp', headers: [{ name: 'H', value: 'v' }] }
    ] as any),
    [
      { name: 'probe', config: { command: '/bin/echo', args: ['hi'], env: { A: 'b' } } },
      { name: 'web', config: { type: 'http', url: 'https://example.com/mcp', headers: { H: 'v' } } }
    ]
  )
})

test('toPiMcpHandoff refuses SSE and ACP-transport elements', () => {
  for (const server of [
    { name: 'stream', type: 'sse', url: 'https://example.com/sse', headers: [] },
    { name: 'chan', type: 'acp', id: 'x' }
  ]) {
    let threw = false
    try {
      toPiMcpHandoff([server] as any)
    } catch (e: any) {
      threw = true
      assert.equal(e?.code, -32602)
      assert.match(String(e?.data?.message ?? e?.message ?? e), /stdio and HTTP/i)
    }
    assert.equal(threw, true)
  }
})

test('toPiMcpHandoff rejects invalid names before building entries', () => {
  const badNames: Array<[any, RegExp]> = [
    [{ name: '', command: 'x' }, /non-empty/],
    [{ name: 'bad name!', command: 'x' }, /invalid characters/],
    [{ name: 'with space', command: 'x' }, /invalid characters/],
    [{ name: 'no-dot.here', command: 'x' }, /invalid characters/]
  ]
  for (const [server, message] of badNames) {
    assert.throws(
      () => toPiMcpHandoff([server] as any),
      (e: any) => e?.code === -32602 && message.test(String(e?.data?.message ?? e?.message ?? e))
    )
  }
})

test('toPiMcpHandoff rejects duplicate and namespace-colliding names', () => {
  const dupes = [
    { name: 'a', command: 'x' },
    { name: 'a', command: 'y' }
  ]
  assert.throws(
    () => toPiMcpHandoff(dupes as any),
    (e: any) => e?.code === -32602 && /Duplicate MCP server name "a"/.test(String(e?.data?.message ?? e?.message ?? e))
  )
  const colliding = [
    { name: 'a-b', command: 'x' },
    { name: 'a_b', command: 'y' }
  ]
  assert.throws(
    () => toPiMcpHandoff(colliding as any),
    (e: any) =>
      e?.code === -32602 &&
      /collides with "a-b"/.test(String(e?.data?.message ?? e?.message ?? e))
  )
})

test('toPiMcpHandoff rejects malformed stdio and HTTP configs', () => {
  assert.throws(
    () => toPiMcpHandoff([{ name: 's', command: '' }] as any),
    (e: any) => e?.code === -32602 && /"s" needs a non-empty command/.test(String(e?.data?.message ?? e?.message ?? e))
  )
  for (const url of ['not a url', 'ftp://example.com/mcp', '']) {
    assert.throws(
      () => toPiMcpHandoff([{ name: 'w', type: 'http', url, headers: [] }] as any),
      (e: any) =>
        e?.code === -32602 &&
        /"w" needs an http or https url/.test(String(e?.data?.message ?? e?.message ?? e))
    )
  }
})

test('toPiMcpHandoff enforces the handoff size cap', () => {
  const big = Array.from({ length: 4000 }, (_, i) => ({
    name: `big${i}`,
    command: 'x'.repeat(30)
  }))
  assert.throws(
    () => toPiMcpHandoff(big as any),
    (e: any) => e?.code === -32602 && /handoff too large/.test(String(e?.data?.message ?? e?.message ?? e))
  )
})

test('handoffSpawnArgs is empty without servers and points at a real bridge file otherwise', () => {
  assert.deepEqual(handoffSpawnArgs([]), {})
  const args = handoffSpawnArgs([{ name: 'probe', command: '/bin/echo', args: [], env: [] }] as any)
  assert.equal(args.extraArgs?.[0], '--extension')
  const bridge = args.extraArgs?.[1] ?? ''
  assert.equal(existsSync(bridge), true)
  const filePath = args.env?.[MCP_SERVERS_FILE_ENV] ?? ''
  assert.ok(filePath)
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), [
    { name: 'probe', config: { command: '/bin/echo', args: [], env: {} } }
  ])
  rmSync(filePath, { force: true })
})

test('bridge registers handoff entries and ignores a missing handoff', () => {
  const registered: Array<{ name: string; config: unknown }> = []
  const record = (name: string, config: unknown): void => {
    registered.push({ name, config })
  }
  const saved = process.env[MCP_SERVERS_FILE_ENV]
  try {
    delete process.env[MCP_SERVERS_FILE_ENV]
    bridge({ registerMcpServer: record })
    assert.equal(registered.length, 0)
  } finally {
    if (saved === undefined) delete process.env[MCP_SERVERS_FILE_ENV]
    else process.env[MCP_SERVERS_FILE_ENV] = saved
  }

  withHandoffFile(JSON.stringify([{ name: 'a', config: { command: 'x' } }]), (filePath) => {
    bridge({ registerMcpServer: record })
    assert.deepEqual(registered, [
      { name: 'a', config: { command: 'x', exposure: 'direct' } }
    ])
    assert.equal(existsSync(filePath), false)
  })
})

test('bridge fails loudly on a malformed handoff', () => {
  for (const raw of ['{nope', '[1]', '[{"name":"","config":{}}]', '[{"name":"a"}]']) {
    withHandoffFile(raw, (filePath) => {
      assert.throws(() => bridge({ registerMcpServer: () => {} }), /PI_ACP_MCP_SERVERS_FILE/)
      assert.equal(existsSync(filePath), false)
    })
  }
})

test('bridge reports a missing handoff file clearly', () => {
  const saved = process.env[MCP_SERVERS_FILE_ENV]
  try {
    process.env[MCP_SERVERS_FILE_ENV] = join(tmpdir(), 'definitely-missing-pi-acp-handoff.json')
    assert.throws(
      () => bridge({ registerMcpServer: () => {} }),
      /PI_ACP_MCP_SERVERS_FILE is missing or unreadable/
    )
  } finally {
    if (saved === undefined) delete process.env[MCP_SERVERS_FILE_ENV]
    else process.env[MCP_SERVERS_FILE_ENV] = saved
  }
})

test('mcpBridgePath resolves inside the repo', () => {
  assert.equal(existsSync(mcpBridgePath()), true)
})