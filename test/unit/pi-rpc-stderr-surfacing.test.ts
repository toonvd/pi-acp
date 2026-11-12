import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('PiRpcProcess.spawn surfaces child stderr when pi dies before the RPC handshake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-stderr-'))
  const launcher = join(root, 'pi')
  writeFileSync(
    launcher,
    [
      '#!/usr/bin/env node',
      // A broken extension bundle: pi prints a stack trace to stderr and never
      // answers get_state (it dies right after the extension load).
      "process.stderr.write(\"BROKEN EXTENSION: Cannot find module './missing'\\n\")",
      'setTimeout(() => process.exit(1), 300)',
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  chmodSync(launcher, 0o755)
  try {
    await assert.rejects(
      () => PiRpcProcess.spawn({ cwd: root, piCommand: launcher }),
      (e: any) => {
        assert.equal(e?.code, -32603, 'must be RequestError.internalError so session/new fails loudly')
        return String(e?.message ?? '').includes('BROKEN EXTENSION')
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiRpcProcess buffers the last ~8 KiB of child stderr for diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-stderr-'))
  const launcher = join(root, 'pi')
  const big = 'ERR'.repeat(5_000) // ~15 KiB > 8 KiB cap
  writeFileSync(
    launcher,
    [
      '#!/usr/bin/env node',
      `process.stderr.write(${JSON.stringify(big)})`,
      'setTimeout(() => process.exit(1), 300)',
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  chmodSync(launcher, 0o755)
  try {
    await assert.rejects(
      () => PiRpcProcess.spawn({ cwd: root, piCommand: launcher }),
      (e: any) => {
        assert.equal(e?.code, -32603)
        const tail = String(e?.message ?? '')
        // The tail must be capped at ~8 KiB and preserve the newest bytes.
        assert.ok(tail.length < 9 * 1024, 'stderr tail must be capped near 8 KiB')
        assert.ok(tail.endsWith('ERR'), 'the newest stderr bytes must be preserved')
        return true
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})