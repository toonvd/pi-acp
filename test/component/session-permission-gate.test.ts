import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(cwd: string) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

function gateUiRequest(id: string, toolCallId: string, title: string, message: string) {
  return { type: 'extension_ui_request', id, method: 'confirm', title, message }
}

test('PiAcpSession: permission-gate confirm requests the REAL tool card with a full-file diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\nmiddle\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'middle', newText: 'changed' }] }
  })

  proc.emit(gateUiRequest('ui-1', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  const req = conn.permissionRequests[0] as any
  assert.equal(req.sessionId, 's1')
  const toolCall = req.toolCall
  assert.equal(toolCall.toolCallId, 't1', 'must use the REAL tool id, not pi-ui-*')
  assert.equal(toolCall.title, 'edit')
  assert.equal(toolCall.kind, 'edit')
  assert.equal(toolCall.status, 'in_progress')
  assert.deepEqual(toolCall.locations, [{ path: filePath, line: 2 }])
  assert.deepEqual(toolCall.rawInput, {
    path: 'a.txt',
    edits: [{ oldText: 'middle', newText: 'changed' }]
  })
  assert.equal(toolCall.content.length, 1)
  const diff = toolCall.content[0]
  assert.equal(diff.type, 'diff')
  assert.equal(diff.path, filePath)
  assert.equal(diff.oldText, 'before\nmiddle\n')
  assert.equal(diff.newText, 'before\nchanged\n')
  assert.deepEqual(req.options, [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
  ])

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', confirmed: true }])
})

test('PiAcpSession: permission-gate reject_once resolves the confirm to false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'reject_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] }
  })

  proc.emit(gateUiRequest('ui-2', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: permission-gate write confirm carries a diff from snapshot to content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'w1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'after\n' }
  })

  proc.emit(gateUiRequest('ui-3', 'w1', 'Allow write?', 'pi-acp:toolcall=w1\nWrite a.txt'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.toolCallId, 'w1')
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff')
  assert.equal(diff.path, filePath)
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-3', confirmed: true }])
})

test('PiAcpSession: permission-gate write of a NEW file uses empty oldText', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'w2',
    toolName: 'write',
    args: { path: 'new.txt', content: 'created\n' }
  })

  proc.emit(gateUiRequest('ui-4', 'w2', 'Allow write?', 'pi-acp:toolcall=w2\nWrite new.txt'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff')
  assert.equal(diff.path, join(dir, 'new.txt'))
  assert.equal(diff.oldText, '', 'new file has empty oldText')
  assert.equal(diff.newText, 'created\n')
})

test('PiAcpSession: cancelled permission-gate confirm resolves to confirmed:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] }
  })

  proc.emit(gateUiRequest('ui-5', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', confirmed: false }])
})

test('PiAcpSession: generic confirm without the gate marker keeps the synthetic pi-ui card', async () => {
  const { conn, proc } = createSession('/tmp')
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'yes' } }

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-6',
    method: 'confirm',
    title: 'Continue?',
    message: 'Plain prompt'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.toolCallId, 'pi-ui-ui-6', 'generic confirm keeps the synthetic card')
  assert.equal(req.toolCall.kind, 'other')
  assert.equal(req.toolCall.status, 'pending')
  assert.deepEqual(req.options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-6', confirmed: true }])
})

test('PiAcpSession: permission-gate confirm falls back to the synthetic card when the tool was never seen', async () => {
  const { conn, proc } = createSession('/tmp')
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  // No tool_execution_start emitted for this id — the adapter must not throw and
  // still resolve the confirm.
  proc.emit(gateUiRequest('ui-7', 'ghost', 'Allow edit?', 'pi-acp:toolcall=ghost\nEdit nope.txt'))

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.toolCallId, 'pi-ui-ui-7')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-7', confirmed: true }])
})

test('PiAcpSession: permission-gate diff reconstructs chained edits against the ORIGINAL, applied right-to-left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'foo\nbar\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: {
      path: 'a.txt',
      edits: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'bar', newText: 'baz' }
      ]
    }
  })
  proc.emit(gateUiRequest('ui-c1', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (2 edits)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff')
  assert.equal(diff.oldText, 'foo\nbar\n')
  // Both oldTexts match against the ORIGINAL, then apply right-to-left, so the
  // reconstruction is bar\nbaz\n — never the buggy sequential baz\nbar\n.
  assert.equal(diff.newText, 'bar\nbaz\n')
})

test('PiAcpSession: permission-gate diff degrades to a text card when an oldText is duplicated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'dup\ndup\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'dup', newText: 'changed' }] }
  })
  proc.emit(gateUiRequest('ui-c2', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const content = req.toolCall.content[0]
  assert.equal(content.type, 'content', 'a duplicated oldText must NOT emit a diff block')
  assert.equal(content.content.type, 'text')
  assert.match(content.content.text, /pi edit: /)
  assert.match(content.content.text, /oldText: "dup"/)
  assert.match(content.content.text, /newText: "changed"/)
})

test('PiAcpSession: permission-gate diff degrades to a text card on overlapping edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'one\ntwo\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: {
      path: 'a.txt',
      edits: [
        { oldText: 'one', newText: 'first' },
        { oldText: 'one\ntwo', newText: 'merged' }
      ]
    }
  })
  proc.emit(gateUiRequest('ui-c3', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (2 edits)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.content[0].type, 'content', 'overlapping edits must NOT emit a diff block')
})

test('PiAcpSession: permission-gate diff normalizes a CRLF snapshot against LF oldText', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'one\r\ntwo\r\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }
  })
  proc.emit(gateUiRequest('ui-c4', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff')
  // Both sides are LF-normalized (pi's edit-diff matches normalized content).
  assert.equal(diff.oldText, 'one\ntwo\n')
  assert.equal(diff.newText, 'one\nTWO\n')
  assert.ok(!diff.oldText.includes('\r') && !diff.newText.includes('\r'))
})

test('PiAcpSession: permission-gate diff strips a leading BOM before matching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, '\uFEFFone\ntwo\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'two', newText: 'TWO' }] }
  })
  proc.emit(gateUiRequest('ui-c5', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff')
  assert.equal(diff.oldText, 'one\ntwo\n', 'BOM must be stripped from the preview')
  assert.equal(diff.newText, 'one\nTWO\n')
})

test('PiAcpSession: permission-gate no-op edit reconstruction emits NO diff block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'foo\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'foo', newText: 'foo' }] }
  })
  proc.emit(gateUiRequest('ui-c6', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.content[0].type, 'content', 'a no-op reconstruction must NOT emit a diff block')
})

test('PiAcpSession: permission-gate no-op write emits NO diff block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'same\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'w1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'same\n' }
  })
  proc.emit(gateUiRequest('ui-c7', 'w1', 'Allow write?', 'pi-acp:toolcall=w1\nWrite a.txt'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const content = req.toolCall.content[0]
  assert.equal(content.type, 'content', 'a no-op write must NOT emit a diff block')
  assert.match(content.content.text, /newText: "same\\n"/)
})

test('PiAcpSession: permission-gate diff handles a single edit OBJECT (pi normalizes to one element)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\nmiddle\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  // pi's edit schema accepts {oldText,newText} as a single edit object.
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: { oldText: 'middle', newText: 'changed' } }
  })
  proc.emit(gateUiRequest('ui-c8', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  const diff = req.toolCall.content[0]
  assert.equal(diff.type, 'diff', 'a single-object edit must still produce a diff')
  assert.equal(diff.oldText, 'before\nmiddle\n')
  assert.equal(diff.newText, 'before\nchanged\n')
})

test('PiAcpSession: a later-line spoofed marker cannot hijack gate correlation (first line wins)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'x\n', 'utf8')

  const { conn, proc } = createSession(dir)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'x', newText: 'y' }] }
  })

  // The real marker is on the first line; a spoofed one is embedded in the path text
  // on a later line. The correlation must still bind to the first line's toolCallId.
  proc.emit(
    gateUiRequest('ui-s1', 'evil', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt\npi-acp:toolcall=evil')
  )

  await new Promise(r => setTimeout(r, 0))

  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.toolCallId, 't1', 'must bind to the first-line marker, not the spoof')
  assert.equal(req.toolCall.content[0].type, 'diff')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-s1', confirmed: true }])
})

test('PiAcpSession: a spoofed marker NOT on the first line does not correlate at all', async () => {
  const { conn, proc } = createSession('/tmp')
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  proc.emit(
    gateUiRequest('ui-s2', 'evil', 'Allow edit?', 'Edit /tmp/x\npi-acp:toolcall=evil')
  )

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  const req = conn.permissionRequests[0] as any
  assert.equal(req.toolCall.toolCallId, 'pi-ui-ui-s2', 'a non-first-line marker must fall back to the synthetic card')
})

test('PiAcpSession: permission-gate confirm resolves cancelled when the client never answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-gate-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const prevTimeout = process.env.PI_ACP_PERMISSION_CONFIRM_TIMEOUT_MS
  process.env.PI_ACP_PERMISSION_CONFIRM_TIMEOUT_MS = '50'

  try {
    const { conn, proc } = createSession(dir)
    // The client never answers: requestPermission stays pending forever.
    conn.nextPermissionResponse = new Promise(() => {}) as any

    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'edit',
      args: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] }
    })
    proc.emit(gateUiRequest('ui-9', 't1', 'Allow edit?', 'pi-acp:toolcall=t1\nEdit a.txt (1 edit)'))

    // After the (short, configurable) ceiling the adapter must reply cancelled so the
    // gate resolves `false` (reject) and the turn cannot wedge.
    const deadline = Date.now() + 5_000
    for (;;) {
      const cancelled = proc.extensionUiResponses.some(
        r => (r as any).id === 'ui-9' && (r as any).cancelled === true
      )
      if (cancelled) break
      if (Date.now() > deadline) assert.fail('expected a cancelled response after the confirm ceiling')
      await new Promise(r => setTimeout(r, 10))
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.PI_ACP_PERMISSION_CONFIRM_TIMEOUT_MS
    else process.env.PI_ACP_PERMISSION_CONFIRM_TIMEOUT_MS = prevTimeout
  }
})