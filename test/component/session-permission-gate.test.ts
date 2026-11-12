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