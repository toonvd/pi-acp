import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBAGENT_STATUS_CLEAR_KEY,
  SUBAGENT_STATUS_KEY_PREFIX,
  isSubagentSessionId,
  parseSubagentSnapshot,
  snapshotTextDelta,
  snapshotToSubagentUpdate,
  subagentRunId,
  subagentSessionId
} from '../../src/acp/translate/subagents.js'

test('subagents: parses a well-formed snapshot', () => {
  const snapshot = parseSubagentSnapshot(
    JSON.stringify({
      version: 1,
      runId: 'run-1',
      agent: 'scout',
      title: 'scout — read a.txt',
      description: 'Read a.txt',
      status: 'running',
      text: 'line one'
    })
  )
  assert.deepEqual(snapshot, {
    runId: 'run-1',
    agent: 'scout',
    title: 'scout — read a.txt',
    description: 'Read a.txt',
    status: 'running',
    text: 'line one'
  })
})

test('subagents: malformed payloads are ignored', () => {
  assert.equal(parseSubagentSnapshot(undefined), null)
  assert.equal(parseSubagentSnapshot(''), null)
  assert.equal(parseSubagentSnapshot('not json'), null)
  assert.equal(parseSubagentSnapshot('null'), null)
  assert.equal(parseSubagentSnapshot('[]'), null)
  assert.equal(parseSubagentSnapshot(JSON.stringify({ agent: 'scout' })), null)
  assert.equal(parseSubagentSnapshot(JSON.stringify({ runId: '   ' })), null)
})

test('subagents: unknown status and long fields are normalised', () => {
  const snapshot = parseSubagentSnapshot(
    JSON.stringify({ runId: 'r', agent: 'x', status: 'weird', title: 'y'.repeat(600), text: 'z'.repeat(70000) })
  )
  assert.ok(snapshot)
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.title.length, 512)
  assert.equal(snapshot.text.length, 65536)
})

test('subagents: terminal statuses survive', () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(parseSubagentSnapshot(JSON.stringify({ runId: 'r', status }))?.status, status)
  }
})

test('subagents: update advertises cancel only for live runs', () => {
  const snapshot = parseSubagentSnapshot(JSON.stringify({ runId: 'r', title: 'scout', status: 'running' }))
  assert.ok(snapshot)
  const live = snapshotToSubagentUpdate(snapshot, { cancel: true })
  assert.equal(live.sessionUpdate, 'subagent_update')
  assert.equal(live.sessionId, 'pi-subagent-r')
  assert.equal(live.title, 'scout')
  assert.deepEqual(live.capabilities, { cancel: {} })
  // `state` is deliberately omitted: SDK 0.26.0 cannot build the tagged union.
  assert.equal('state' in live, false)

  const done = snapshotToSubagentUpdate({ ...snapshot, status: 'completed' }, { cancel: false })
  assert.equal('capabilities' in done, false)
  assert.equal('description' in done, false)
})

test('subagents: text delta only sends what is new', () => {
  assert.equal(snapshotTextDelta('', 'a'), 'a')
  assert.equal(snapshotTextDelta('a', 'a'), '')
  assert.equal(snapshotTextDelta('a', 'ab'), 'b')
  assert.equal(snapshotTextDelta('', ''), '')
  assert.equal(snapshotTextDelta('a\nb', 'a\nc'), '\nc\n')
})

test('subagents: session id helpers round-trip', () => {
  assert.equal(subagentSessionId('run-9'), 'pi-subagent-run-9')
  assert.equal(isSubagentSessionId('pi-subagent-run-9'), true)
  assert.equal(isSubagentSessionId('s1'), false)
  assert.equal(subagentRunId('pi-subagent-run-9'), 'run-9')
  assert.equal(subagentRunId('pi-subagent-'), null)
  assert.equal(subagentRunId('s1'), null)
  assert.equal(SUBAGENT_STATUS_KEY_PREFIX, 'pi-acp:subagent:')
  assert.equal(SUBAGENT_STATUS_CLEAR_KEY, 'pi-acp:subagent:clear')
})
