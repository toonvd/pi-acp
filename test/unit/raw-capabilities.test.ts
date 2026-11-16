import test from 'node:test'
import assert from 'node:assert/strict'
import { detectSubagentsCapability } from '../../src/acp/raw-capabilities.js'

test('detectSubagentsCapability: true when initialize advertises subagents', () => {
  assert.equal(
    detectSubagentsCapability({
      method: 'initialize',
      params: { clientCapabilities: { fs: {}, terminal: true, subagents: {} } }
    }),
    true
  )
})

test('detectSubagentsCapability: false when subagents is absent or not initialize', () => {
  // initialize without subagents
  assert.equal(detectSubagentsCapability({ method: 'initialize', params: { clientCapabilities: { fs: {} } } }), false)
  // not an initialize message
  assert.equal(detectSubagentsCapability({ method: 'session/new', params: { cwd: '/' } }), false)
  // non-object / null
  assert.equal(detectSubagentsCapability(null), false)
  assert.equal(detectSubagentsCapability('initialize'), false)
})
