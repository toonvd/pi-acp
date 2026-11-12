import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}

test('PiAcpSession: bash tool_call update carries parentToolCallId merged into terminal _meta', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 'b1', name: 'bash', arguments: { command: 'ls' } }
    },
    parentToolCallId: 'parent-1'
  })

  await tick()

  const toolCall = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')
  assert.ok(toolCall, 'expected tool_call')
  assert.deepEqual((toolCall.update as any)._meta, {
    terminal_info: { terminal_id: 'b1', cwd: process.cwd() },
    parentToolCallId: 'parent-1'
  })
})

test('PiAcpSession: nested bash tool_execution_end surfaces parentToolCallId in _meta', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'b2',
    toolName: 'bash',
    args: { command: 'ls' },
    parentToolCallId: 'parent-1'
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b2',
    parentToolCallId: 'parent-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'out' }] }
  })

  await tick()

  const end = conn.updates.find(
    u =>
      u.update.sessionUpdate === 'tool_call_update' &&
      (u.update as any).toolCallId === 'b2' &&
      (u.update as any).status === 'completed'
  )
  assert.ok(end, 'expected completed tool_call_update')
  assert.deepEqual((end.update as any)._meta, {
    terminal_output: { terminal_id: 'b2', data: 'out' },
    terminal_exit: { terminal_id: 'b2', exit_code: 0, signal: null },
    parentToolCallId: 'parent-1'
  })
})

test('PiAcpSession: streamed tool_call_update carries a title derived from toolCallTitle', async () => {
  const { conn, proc } = createSession()

  // First delta: surfaces tool_call and marks the call pending.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 's1', name: 'subagent', arguments: { agent: 'scout', task: 'recon' } }
    }
  })
  // Second delta: existingStatus is pending -> tool_call_update must include the title.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: { id: 's1', name: 'subagent', arguments: { agent: 'scout', task: 'recon' } }
    }
  })

  await tick()

  const update = conn.updates.find(
    u => u.update.sessionUpdate === 'tool_call_update' && (u.update as any).toolCallId === 's1'
  )
  assert.ok(update, 'expected tool_call_update')
  assert.equal((update.update as any).title, 'subagent: scout — recon')
})

test('PiAcpSession: tool_execution_start transition keeps toolCallTitle as the update title', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 's2', name: 'subagent', arguments: { agent: 'scout', task: 'recon' } }
    }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 's2',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'recon' },
    parentToolCallId: 'parent-2'
  })

  await tick()

  const update = conn.updates.find(
    u => u.update.sessionUpdate === 'tool_call_update' && (u.update as any).toolCallId === 's2'
  )
  assert.ok(update, 'expected tool_call_update')
  assert.equal((update.update as any).title, 'subagent: scout — recon')
  assert.deepEqual((update.update as any)._meta, { parentToolCallId: 'parent-2' })
})