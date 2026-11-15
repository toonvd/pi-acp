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

test('PiAcpSession: todo tool_execution_end with details emits a plan update', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'todo-1',
    toolName: 'todo',
    isError: false,
    result: {
      details: {
        todos: [
          { content: 'First', status: 'pending', priority: 'high' },
          { content: 'Second', status: 'in_progress', priority: 'medium', extra: 'stripped' },
          { content: 1, status: 'pending', priority: 'high' }
        ]
      }
    }
  })

  await tick()

  const plan = conn.updates.find(u => u.update.sessionUpdate === 'plan')
  assert.ok(plan, 'expected a plan update')
  assert.deepEqual((plan.update as any).entries, [
    { content: 'First', status: 'pending', priority: 'high' },
    { content: 'Second', status: 'in_progress', priority: 'medium' }
  ])
})

test('PiAcpSession: errored todo tool_execution_end emits no plan', async () => {
  const { conn, proc } = createSession()

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'todo-err',
    toolName: 'todo',
    isError: true,
    result: { details: { todos: [{ content: 'X', status: 'pending', priority: 'high' }] } }
  })

  await tick()

  assert.ok(
    !conn.updates.some(u => u.update.sessionUpdate === 'plan'),
    'expected no plan update for an errored todo call'
  )
})
