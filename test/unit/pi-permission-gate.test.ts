import test from 'node:test'
import assert from 'node:assert/strict'
import gate from '../../src/acp/pi-permission-gate.js'

type GateHandler = (event: unknown, ctx: unknown) => Promise<unknown>
type ConfirmCall = { title: string; message: string }

function loadGate(confirm: (title: string, message: string) => Promise<unknown>) {
  const handlers: Record<string, GateHandler[]> = {}
  const pi = {
    on(event: string, handler: GateHandler) {
      handlers[event] ??= []
      handlers[event].push(handler)
    }
  }
  const confirmCalls: ConfirmCall[] = []
  const ctx = {
    ui: {
      confirm: async (title: string, message: string) => {
        confirmCalls.push({ title, message })
        return confirm(title, message)
      }
    }
  }
  gate(pi as any)
  return { handler: handlers.tool_call?.[0], confirmCalls, ctx }
}

function toolCall(overrides: Record<string, unknown>) {
  return { type: 'tool_call', toolName: 'edit', toolCallId: 'tc-1', input: {}, ...overrides }
}

test('pi-permission-gate: does not gate read or bash tools', async () => {
  const { handler, confirmCalls, ctx } = loadGate(async () => false)
  for (const toolName of ['read', 'bash']) {
    const result = await handler!(toolCall({ toolName }), ctx)
    assert.equal(result, undefined)
  }
  assert.equal(confirmCalls.length, 0)
})

test('pi-permission-gate: skips child tool calls with a parentToolCallId', async () => {
  const { handler, confirmCalls, ctx } = loadGate(async () => false)
  const result = await handler!(
    toolCall({ toolName: 'edit', parentToolCallId: 'parent-1' }),
    ctx
  )
  assert.equal(result, undefined)
  assert.equal(confirmCalls.length, 0)
})

test('pi-permission-gate: allows the tool when the user confirms true', async () => {
  const { handler, confirmCalls, ctx } = loadGate(async () => true)
  const result = await handler!(toolCall({ toolName: 'edit' }), ctx)
  assert.equal(result, undefined)
  assert.equal(confirmCalls.length, 1)
  assert.equal(confirmCalls[0].title, 'Allow edit?')
  assert.ok(confirmCalls[0].message.includes('pi-acp:toolcall=tc-1'))
  assert.ok(confirmCalls[0].message.includes('Edit'))
})

test('pi-permission-gate: includes the path and edit count in the message', async () => {
  const { handler, confirmCalls, ctx } = loadGate(async () => true)
  await handler!(
    toolCall({
      input: { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'z', newText: 'w' }] }
    }),
    ctx
  )
  assert.equal(confirmCalls[0].message, 'pi-acp:toolcall=tc-1\nEdit src/a.ts (2 edits)')
})

test('pi-permission-gate: blocks the tool with the ACP reason when the user rejects', async () => {
  const { handler, ctx } = loadGate(async () => false)
  const result = await handler!(toolCall({ toolName: 'edit' }), ctx)
  assert.deepEqual(result, { block: true, reason: 'User rejected this edit in the ACP client' })
})

test('pi-permission-gate: blocks when confirm resolves undefined', async () => {
  const { handler, ctx } = loadGate(async () => undefined)
  const result = await handler!(toolCall({ toolName: 'write' }), ctx)
  assert.deepEqual(result, { block: true, reason: 'User rejected this write in the ACP client' })
})

test('pi-permission-gate: never registers when PI_ACP_PERMISSION_GATE=0', async () => {
  const prev = process.env.PI_ACP_PERMISSION_GATE
  process.env.PI_ACP_PERMISSION_GATE = '0'
  try {
    const handlers: Record<string, unknown[]> = {}
    const pi = {
      on(event: string, handler: unknown) {
        handlers[event] ??= []
        handlers[event].push(handler)
      }
    }
    gate(pi as any)
    assert.equal(handlers.tool_call, undefined, 'no tool_call handler when the gate is disabled')
  } finally {
    if (prev === undefined) delete process.env.PI_ACP_PERMISSION_GATE
    else process.env.PI_ACP_PERMISSION_GATE = prev
  }
})

test('pi-permission-gate: defaults to allowing when the handler throws internally', async () => {
  const { handler, ctx } = loadGate(async () => {
    throw new Error('boom')
  })
  const result = await handler!(toolCall({ toolName: 'edit' }), ctx)
  assert.equal(result, undefined, 'internal errors must default to allow, never throw')
})