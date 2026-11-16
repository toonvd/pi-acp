import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { SubagentBridge } from '../../src/acp/client-bridge.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(subagentsBridge?: SubagentBridge) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    ...(subagentsBridge ? { subagentsBridge } : {})
  })

  return { conn, proc, session }
}

function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}

function snapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    runId: 'run-1',
    agent: 'scout',
    title: 'scout — read a.txt',
    description: 'Read a.txt',
    status: 'running',
    text: 'step one',
    ...overrides
  })
}

function setStatus(proc: FakePiRpcProcess, key: string, text: string, id = 'ui-1'): void {
  // The REAL pi RPC wire names these statusKey/statusText (verified live); the adapter
  // must read them, not the assumed key/text.
  proc.emit({ type: 'extension_ui_request', id, method: 'setStatus', statusKey: key, statusText: text })
}

test('PiAcpSession: subagent snapshot announces a child session with a Stop button', async () => {
  const bridge = { cancel: async () => ({ ok: true }) } as unknown as SubagentBridge
  const { conn, proc } = createSession(bridge)

  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()

  const announced = conn.updates.find(u => (u.update as any).sessionUpdate === 'subagent_update')
  assert.ok(announced)
  assert.equal(announced.sessionId, 's1')
  assert.equal((announced.update as any).sessionId, 'pi-subagent-run-1')
  assert.equal((announced.update as any).title, 'scout — read a.txt')
  assert.deepEqual((announced.update as any).capabilities, { cancel: {} })

  const child = conn.updates.find(u => u.sessionId === 'pi-subagent-run-1')
  assert.ok(child)
  assert.equal((child.update as any).sessionUpdate, 'agent_message_chunk')
  assert.equal((child.update as any).content.text, 'step one')
})

test('PiAcpSession: subagent snapshots surface the fleet as plan entries (no bridge needed)', async () => {
  const { conn, proc } = createSession()

  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()

  let plan = conn.updates.find(u => (u.update as any).sessionUpdate === 'plan')
  assert.ok(plan)
  assert.deepEqual((plan.update as any).entries, [
    { content: 'scout — read a.txt', priority: 'medium', status: 'in_progress' }
  ])

  setStatus(proc, 'pi-acp:subagent:run-1', snapshot({ status: 'completed', text: 'done' }), 'ui-2')
  await tick()

  plan = conn.updates.filter(u => (u.update as any).sessionUpdate === 'plan').pop()!
  assert.deepEqual((plan.update as any).entries, [
    { content: 'scout — read a.txt', priority: 'low', status: 'completed' }
  ])
})

test('PiAcpSession: unchanged snapshots emit nothing', async () => {
  const { conn, proc } = createSession()
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()
  const count = conn.updates.length

  setStatus(proc, 'pi-acp:subagent:run-1', snapshot(), 'ui-2')
  await tick()
  assert.equal(conn.updates.length, count)
})

test('PiAcpSession: grown snapshots stream only the new text', async () => {
  const { conn, proc } = createSession()
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot({ text: 'step one\nstep two' }), 'ui-2')
  await tick()

  const chunks = conn.updates.filter(u => u.sessionId === 'pi-subagent-run-1')
  assert.equal(chunks.length, 2)
  assert.equal((chunks[1].update as any).content.text, '\nstep two')
})

test('PiAcpSession: terminal snapshots stop advertising cancel', async () => {
  const { conn, proc } = createSession()
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot({ status: 'completed', text: 'done' }), 'ui-2')
  await tick()

  const announcements = conn.updates.filter(u => (u.update as any).sessionUpdate === 'subagent_update')
  assert.equal(announcements.length, 2)
  assert.equal('capabilities' in (announcements[1].update as any), false)
})

test('PiAcpSession: malformed or foreign status keys are ignored', async () => {
  const { conn, proc } = createSession()
  setStatus(proc, 'pi-acp:subagent:run-1', 'not json')
  setStatus(proc, 'other:key', snapshot(), 'ui-2')
  await tick()
  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: cancelSubagent routes the run id to the bridge', async () => {
  const cancelled: string[] = []
  const bridge = {
    cancel: async (runId: string) => {
      cancelled.push(runId)
      return { ok: true }
    }
  } as unknown as SubagentBridge
  const { proc, session } = createSession(bridge)
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot())
  await tick()

  assert.equal(session.ownsSubagent('pi-subagent-run-1'), true)
  assert.equal(await session.cancelSubagent('run-1'), true)
  assert.deepEqual(cancelled, ['run-1'])
})

test('PiAcpSession: plan title uses the parent tool call task paired by toolCallId (agent — task)', async () => {
  const { conn, proc } = createSession()

  // The parent launches a scout subagent with the real task text; the adapter captures it.
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'recon the repo layout' }
  })

  // The extension snapshot pairs to that tool call via status.json's toolCallId; its own
  // title is just the agent (description is redacted at the pi-subagents source).
  setStatus(proc, 'pi-acp:subagent:run-1', snapshot({ title: 'scout', description: undefined, toolCallId: 't1' }))
  await tick()

  const plan = conn.updates.find(u => (u.update as any).sessionUpdate === 'plan')
  assert.ok(plan)
  assert.deepEqual((plan.update as any).entries, [
    { content: 'scout — recon the repo layout', priority: 'medium', status: 'in_progress' }
  ])

  const announced = conn.updates.find(u => (u.update as any).sessionUpdate === 'subagent_update')
  assert.ok(announced)
  assert.equal((announced.update as any).title, 'scout — recon the repo layout')
})
