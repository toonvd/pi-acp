// E2E: the edit/write permission gate must surface a `session/request_permission`
// carrying a full-file `diff` BEFORE the tool runs, and the file must change only
// when the client replies allow_once (reject_once must leave it untouched while
// the turn still completes).
//
// Drives `node dist/index.js` over stdio like scripts/repro-diff.mjs:
//   initialize -> session/new (cwd = fresh tmp dir) -> session/prompt (edit one line)
//   -> reply to session/request_permission with allow_once -> verify file changed
//   -> second session/prompt -> reply reject_once -> verify file unchanged + turn completes
// Logs EVERY inbound JSON-RPC message as one JSON line prefixed with `>>`.
// Hard timeout 240s; kills child and exits non-zero on timeout.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoCwd = process.cwd()
const PI_ACP_PI_COMMAND = process.env.PI_ACP_PI_COMMAND ?? '/Users/toon/.pi/agent/bin/pi'
const HARD_TIMEOUT_MS = 240_000
const GRACE_MS = 800

const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-gate-e2e-')))
const targetFile = join(workdir, 'gate.txt')
const knownContent = ['line one', 'line two', 'line three'].join('\n') + '\n'
writeFileSync(targetFile, knownContent, 'utf8')

console.log(`[e2e] workdir=${workdir}`)
console.log(`[e2e] targetFile=${targetFile}`)
console.log(`[e2e] PI_ACP_PI_COMMAND=${PI_ACP_PI_COMMAND}`)
console.log(`[e2e] initial file content:\n${knownContent}`)

const child = spawn('node', ['dist/index.js'], {
  cwd: repoCwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_ACP_PI_COMMAND }
})

let stdoutBuffer = ''
let timedOut = false
let finished = false
let phase = 'allow' // 'allow' -> 'reject' -> 'crlf'
let allowPermissionCount = 0
let rejectPermissionCount = 0
let crlfPermissionCount = 0
let sessionId = null
const rawPermissionRequests = []

const timer = setTimeout(() => {
  timedOut = true
  console.error('[e2e] HARD TIMEOUT reached; killing child and exiting non-zero')
  child.kill('SIGKILL')
  process.exitCode = 1
  process.exit(1)
}, HARD_TIMEOUT_MS)

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  stdoutBuffer += chunk
  const lines = stdoutBuffer.split('\n')
  stdoutBuffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.log(`>>RAW ${line}`)
      continue
    }
    console.log(`>> ${JSON.stringify(msg)}`)
    handleMessage(msg)
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    if (line.trim()) console.log(`>>ERR ${line}`)
  }
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (timedOut) return
  if (!finished) {
    console.error(`[e2e] child exited early: code=${code} signal=${signal}`)
    process.exitCode = code ?? 1
    process.exit(process.exitCode)
  }
})

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

function fail(message) {
  console.error(`[e2e] ASSERTION FAILED: ${message}`)
  console.error(`[e2e] raw permission requests so far:\n${JSON.stringify(rawPermissionRequests, null, 2)}`)
  child.kill('SIGKILL')
  process.exitCode = 1
  process.exit(1)
}

function verifyPermissionRequest(params) {
  const { sessionId, toolCall, options } = params
  if (typeof sessionId !== 'string' || !sessionId) fail('request_permission missing sessionId')
  if (!toolCall || typeof toolCall !== 'object') fail('request_permission missing toolCall')
  if (String(toolCall.toolCallId).startsWith('pi-ui-')) {
    fail(`toolCall must be the REAL tool card, got synthetic id ${toolCall.toolCallId}`)
  }
  const optionIds = (options ?? []).map(o => o.optionId).sort()
  const expected = ['allow_once', 'reject_once']
  if (JSON.stringify(optionIds) !== JSON.stringify(expected)) {
    fail(`expected options ${expected}, got ${JSON.stringify(optionIds)}`)
  }
  const diff = (toolCall.content ?? []).find(c => c.type === 'diff')
  if (!diff) fail('permission toolCall must carry a diff content block')
  if (typeof diff.path !== 'string' || !diff.path.startsWith(workdir)) {
    fail(`diff.path must be absolute inside the workdir, got ${diff.path}`)
  }
  if (typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') {
    fail('diff must carry oldText/newText strings')
  }
  return { diff }
}

// Basic ACP handshake first.
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: workdir, mcpServers: [] } })

function handleMessage(msg) {
  // ACP client method: agent -> client request asking for permission.
  if (msg?.method === 'session/request_permission') {
    rawPermissionRequests.push(msg)
    const { diff } = verifyPermissionRequest(msg.params)
    const decision = phase === 'reject' ? 'reject_once' : 'allow_once'
    console.log(`[e2e] permission request #${phase === 'allow' ? allowPermissionCount + 1 : phase === 'reject' ? rejectPermissionCount + 1 : crlfPermissionCount + 1} (${phase}) -> ${decision}`)
    if (phase === 'allow') allowPermissionCount += 1
    else if (phase === 'reject') rejectPermissionCount += 1
    else crlfPermissionCount += 1
    console.log(`[e2e] diff.path=${diff.path}`)
    console.log(`[e2e] diff.oldText (first 60 chars)=${diff.oldText.slice(0, 60).replace(/\n/g, '\\n')}`)
    console.log(`[e2e] diff.newText (first 60 chars)=${diff.newText.slice(0, 60).replace(/\n/g, '\\n')}`)

    if (phase === 'allow') {
      if (!diff.oldText.includes('line two')) fail('allow diff.oldText must contain "line two"')
      if (!diff.newText.includes('line two CHANGED')) fail('allow diff.newText must contain "line two CHANGED"')
    } else if (phase === 'reject') {
      if (!diff.oldText.includes('line three')) fail('reject diff.oldText must contain "line three"')
      if (!diff.newText.includes('line three CHANGED')) fail('reject diff.newText must contain "line three CHANGED"')
    } else {
      // CRLF file: the preview must match pi's LF-normalized reconstruction, never a
      // raw CRLF compare (which would silently show no change and hide the edit).
      if (!diff.oldText.includes('line two')) fail('crlf diff.oldText must contain "line two"')
      if (!diff.newText.includes('line two CRLF CHANGED')) fail('crlf diff.newText must contain "line two CRLF CHANGED"')
      if (diff.oldText.includes('\r')) fail('crlf diff.oldText must be LF-normalized (no CR chars)')
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { outcome: { outcome: 'selected', optionId: decision } }
    })
    return
  }

  // session/new response -> send first prompt.
  if (msg?.id === 2 && msg?.result?.sessionId) {
    sessionId = msg.result.sessionId
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          {
            type: 'text',
            text:
              `Edit the file gate.txt in the session working directory. ` +
              `Change ONLY the line that reads "line two" to read "line two CHANGED". ` +
              `Do not modify any other line.`
          }
        ]
      }
    })
    return
  }

  // First turn finished (allow phase).
  if (msg?.id === 3 && msg?.result) {
    setTimeout(() => {
      if (allowPermissionCount === 0) fail('allow phase: no permission request was observed')
      const afterAllow = readFileSync(targetFile, 'utf8')
      console.log(`[e2e] file after allow_once turn:\n${afterAllow}`)
      if (!afterAllow.includes('line two CHANGED')) fail('allow phase: file was NOT edited after allow_once')
      if (!afterAllow.includes('line three')) fail('allow phase: unrelated line was modified')

      phase = 'reject'
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                `Edit the file gate.txt in the session working directory. ` +
                `Change ONLY the line that reads "line three" to read "line three CHANGED". ` +
                `Do not modify any other line.`
            }
          ]
        }
      })
    }, GRACE_MS)
    return
  }

  // Second turn finished (reject phase) -> rewrite as CRLF and edit again (allow).
  if (msg?.id === 4 && msg?.result) {
    setTimeout(() => {
      if (rejectPermissionCount === 0) fail('reject phase: no permission request was observed')
      const afterReject = readFileSync(targetFile, 'utf8')
      console.log(`[e2e] file after reject_once turn:\n${afterReject}`)
      if (afterReject.includes('line three CHANGED')) fail('reject phase: file WAS edited despite reject_once')
      if (!afterReject.includes('line two CHANGED')) fail('reject phase: earlier allow edit was lost')
      if (msg.result.stopReason === 'error') fail(`reject phase: turn errored: ${JSON.stringify(msg.result.error)}`)

      // Switch the file to CRLF so the third turn exercises the CRLF-normalized diff path.
      writeFileSync(targetFile, knownContent.replace(/\n/g, '\r\n'), 'utf8')
      console.log('[e2e] rewrote gate.txt with CRLF line endings for the crlf phase')
      phase = 'crlf'
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                `Edit the file gate.txt in the session working directory. ` +
                `Change ONLY the line that reads "line two" to read "line two CRLF CHANGED". ` +
                `Do not modify any other line.`
            }
          ]
        }
      })
    }, GRACE_MS)
    return
  }

  // Third turn finished (crlf allow phase).
  if (msg?.id === 5 && msg?.result) {
    setTimeout(() => {
      if (crlfPermissionCount === 0) fail('crlf phase: no permission request was observed')
      const afterCrlf = readFileSync(targetFile, 'utf8')
      console.log(`[e2e] file after crlf allow_once turn (escaped):\n${JSON.stringify(afterCrlf)}`)
      if (!afterCrlf.includes('line two CRLF CHANGED')) fail('crlf phase: file was NOT edited after allow_once')
      if (!afterCrlf.includes('\r\n')) fail('crlf phase: file lost its CRLF line endings')
      if (msg.result.stopReason === 'error') fail(`crlf phase: turn errored: ${JSON.stringify(msg.result.error)}`)

      console.log('[e2e] SUCCESS: allow_once edited the file; reject_once left it unchanged; CRLF diff + edit landed; all turns completed')
      console.log(`[e2e] permission requests: allow=${allowPermissionCount} reject=${rejectPermissionCount} crlf=${crlfPermissionCount}`)
      console.log(`[e2e] raw permission request JSON (first allow):\n${JSON.stringify(rawPermissionRequests[0], null, 2)}`)
      finished = true
      clearTimeout(timer)
      child.kill('SIGTERM')
    }, GRACE_MS)
  }
}