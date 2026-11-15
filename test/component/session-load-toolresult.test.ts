import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { command: 'echo hello' },
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableThinkingLevels: async () => ['medium'],
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays edit/write as structured diffs and read as text', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_edit',
                name: 'edit',
                arguments: { path: '/tmp/project/src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] }
              },
              {
                type: 'toolCall',
                id: 'call_write',
                name: 'write',
                arguments: { path: '/tmp/project/b.ts', content: 'new' }
              },
              { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'src/c.ts' } },
              {
                type: 'toolCall',
                id: 'call_failed_edit',
                name: 'edit',
                arguments: { path: '/tmp/project/src/d.ts', edits: [{ oldText: 'x', newText: 'y' }] }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_edit',
            toolName: 'edit',
            content: [{ type: 'text', text: 'ok' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_write',
            toolName: 'write',
            content: [{ type: 'text', text: 'ok' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_read',
            toolName: 'read',
            content: [{ type: 'text', text: 'file contents' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_failed_edit',
            toolName: 'edit',
            content: [{ type: 'text', text: 'edit failed' }],
            isError: true
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => ['medium'],
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    const updates = conn.updates.map(u => (u as any).update)

    const calls = Object.fromEntries(updates.filter(u => u?.sessionUpdate === 'tool_call').map(u => [u.toolCallId, u]))
    const results = Object.fromEntries(
      updates.filter(u => u?.sessionUpdate === 'tool_call_update').map(u => [u.toolCallId, u])
    )

    // edit replays a diff built from its tool args, with absolute path and no rawOutput.
    assert.equal(calls.call_edit.title, 'edit')
    assert.equal(calls.call_edit.kind, 'edit')
    assert.deepEqual(calls.call_edit.locations, [{ path: '/tmp/project/src/a.ts' }])
    assert.deepEqual(calls.call_edit.rawInput, {
      path: '/tmp/project/src/a.ts',
      edits: [{ oldText: 'foo', newText: 'bar' }]
    })
    assert.deepEqual(results.call_edit.content, [
      { type: 'diff', path: '/tmp/project/src/a.ts', oldText: 'foo', newText: 'bar' }
    ])
    assert.equal(results.call_edit.status, 'completed')
    assert.equal(results.call_edit.rawOutput, undefined, 'expected rawOutput suppressed when a diff is emitted')

    // write replays a full-file diff with unknown prior content.
    assert.deepEqual(results.call_write.content, [
      { type: 'diff', path: '/tmp/project/b.ts', oldText: null, newText: 'new' }
    ])
    assert.equal(results.call_write.rawOutput, undefined)

    // read has no diff: replays as text with a title and args derived from the toolCall block.
    assert.equal(calls.call_read.title, 'read')
    assert.equal(calls.call_read.kind, 'read')
    assert.deepEqual(calls.call_read.locations, [{ path: '/tmp/project/src/c.ts' }])
    assert.deepEqual(calls.call_read.rawInput, { path: 'src/c.ts' })
    assert.deepEqual(results.call_read.content, [{ type: 'content', content: { type: 'text', text: 'file contents' } }])
    assert.equal(results.call_read.status, 'completed')
    assert.deepEqual(results.call_read.rawOutput.content, [{ type: 'text', text: 'file contents' }])

    // failed edit replays as failed with text and no diff.
    assert.equal(results.call_failed_edit.status, 'failed')
    assert.deepEqual(results.call_failed_edit.content, [
      { type: 'content', content: { type: 'text', text: 'edit failed' } }
    ])
    assert.notEqual(results.call_failed_edit.rawOutput, undefined, 'expected rawOutput kept when no diff is emitted')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
