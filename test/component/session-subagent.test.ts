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

test('PiAcpSession: subagent tool_call carries kind other and a title with agent name + task', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'recon the repo' }
  })

  await new Promise(r => setTimeout(r, 0))

  const toolCall = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')
  assert.ok(toolCall, 'expected tool_call')
  assert.equal((toolCall.update as any).toolCallId, 't1')
  assert.equal((toolCall.update as any).title, 'subagent: scout — recon the repo')
  assert.equal((toolCall.update as any).kind, 'other')
})

test('PiAcpSession: subagent parallel workflow titles with task count', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { workflow: 'parallel', args: { tasks: [{ agent: 'a' }, { agent: 'b' }, { agent: 'c' }] } }
  })

  await new Promise(r => setTimeout(r, 0))

  const toolCall = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')
  assert.ok(toolCall, 'expected tool_call')
  assert.equal((toolCall.update as any).title, 'subagent: parallel (3 tasks)')
  assert.equal((toolCall.update as any).kind, 'other')
})

test('PiAcpSession: nested subagent tool_call surfaces parentToolCallId in _meta', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'child-1',
    toolName: 'subagent',
    parentToolCallId: 'parent-1',
    args: { agent: 'scout', task: 'recon the repo' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'child-1',
    parentToolCallId: 'parent-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const toolCall = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')
  assert.ok(toolCall, 'expected tool_call')
  assert.deepEqual((toolCall.update as any)._meta, { parentToolCallId: 'parent-1' })

  const end = conn.updates.find(
    u => u.update.sessionUpdate === 'tool_call_update' && (u.update as any).toolCallId === 'child-1' && (u.update as any).status === 'completed'
  )
  assert.ok(end, 'expected completed tool_call_update')
  assert.deepEqual((end.update as any)._meta, { parentToolCallId: 'parent-1' })
})

test('PiAcpSession: non-subagent tool calls keep their raw tool name as the title', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'read',
    args: { path: 'a.txt' }
  })

  await new Promise(r => setTimeout(r, 0))

  const toolCall = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')
  assert.ok(toolCall, 'expected tool_call')
  assert.equal((toolCall.update as any).title, 'read')
  assert.equal((toolCall.update as any).kind, 'read')
  assert.equal((toolCall.update as any)._meta, undefined, 'no parentToolCallId means no _meta')
})