import test from 'node:test'
import assert from 'node:assert/strict'
import { historicDiffContent } from '../../src/acp/translate/tool-args.js'

test('historicDiffContent: edit with one hunk yields a single diff', () => {
  const diff = historicDiffContent('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'foo', newText: 'bar' }]
  })
  assert.deepEqual(diff, [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }])
})

test('historicDiffContent: edit with multiple hunks yields one diff per replacement', () => {
  const diff = historicDiffContent('edit', {
    path: 'src/a.ts',
    edits: [
      { oldText: 'foo', newText: 'bar' },
      { oldText: 'baz', newText: 'qux' }
    ]
  })
  assert.deepEqual(diff, [
    { type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' },
    { type: 'diff', path: 'src/a.ts', oldText: 'baz', newText: 'qux' }
  ])
})

test('historicDiffContent: edit with stringified edits is parsed', () => {
  const diff = historicDiffContent('edit', {
    path: 'src/a.ts',
    edits: JSON.stringify([{ oldText: 'foo', newText: 'bar' }])
  })
  assert.deepEqual(diff, [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }])
})

test('historicDiffContent: edit accepts legacy top-level oldText/newText', () => {
  const diff = historicDiffContent('edit', { path: 'src/a.ts', oldText: 'foo', newText: 'bar' })
  assert.deepEqual(diff, [{ type: 'diff', path: 'src/a.ts', oldText: 'foo', newText: 'bar' }])
})

test('historicDiffContent: write with content yields a full-file diff', () => {
  const diff = historicDiffContent('write', { path: '/tmp/project/b.ts', content: 'new' })
  assert.deepEqual(diff, [{ type: 'diff', path: '/tmp/project/b.ts', oldText: null, newText: 'new' }])
})

test('historicDiffContent: non-mutating tool returns undefined', () => {
  assert.equal(historicDiffContent('read', { path: 'src/a.ts' }), undefined)
})

test('historicDiffContent: missing path returns undefined', () => {
  assert.equal(historicDiffContent('edit', { edits: [{ oldText: 'foo', newText: 'bar' }] }), undefined)
  assert.equal(historicDiffContent('write', { content: 'new' }), undefined)
})
