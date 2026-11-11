// Headless repro: does an ACP `diff` tool-call-update actually reach the client
// when the agent (`pi` via `PI_ACP_PI_COMMAND`) edits a file on disk?
//
// Drives `node dist/index.js` over stdio like scripts/smoke-acp.mjs:
//   initialize -> session/new (cwd = fresh tmp dir) -> session/prompt (edit one line)
// Logs EVERY inbound JSON-RPC message as one JSON line prefixed with `>>`.
// Hard timeout 180s; kills child and exits non-zero on timeout.
// Finally reads and prints the target file from disk.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoCwd = process.cwd()
const PI_ACP_PI_COMMAND = process.env.PI_ACP_PI_COMMAND ?? '/Users/toon/.pi/agent/bin/pi'
const HARD_TIMEOUT_MS = 180_000
const GRACE_MS = 500

const workdir = mkdtempSync(join(tmpdir(), 'pi-acp-repro-'))
const targetFile = join(workdir, 'repro.txt')
const knownContent = ['line one', 'line two', 'line three'].join('\n') + '\n'
writeFileSync(targetFile, knownContent, 'utf8')

console.log(`[repro] workdir=${workdir}`)
console.log(`[repro] targetFile=${targetFile}`)
console.log(`[repro] PI_ACP_PI_COMMAND=${PI_ACP_PI_COMMAND}`)
console.log(`[repro] initial file content:\n${knownContent}`)

const child = spawn('node', ['dist/index.js'], {
  cwd: repoCwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_ACP_PI_COMMAND }
})

let stdoutBuffer = ''
let stderrBuffer = ''
let timedOut = false
let finished = false

const timer = setTimeout(() => {
  timedOut = true
  console.error('[repro] HARD TIMEOUT reached; killing child and exiting non-zero')
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
  stderrBuffer += chunk
  for (const line of chunk.split('\n')) {
    if (line.trim()) console.log(`>>ERR ${line}`)
  }
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (timedOut) return
  if (!finished) {
    console.error(`[repro] child exited early: code=${code} signal=${signal}`)
    process.exitCode = code ?? 1
    process.exit(process.exitCode)
  }
})

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

// Basic ACP handshake first.
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: workdir, mcpServers: [] } })

function handleMessage(msg) {
  // session/new response -> write file is already done; send prompt.
  if (msg?.id === 2 && msg?.result?.sessionId) {
    const sessionId = msg.result.sessionId
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
              `Edit the file repro.txt in the session working directory. ` +
              `Change ONLY the line that reads "line two" to read "line two CHANGED". ` +
              `Do not modify any other line.`
          }
        ]
      }
    })
  }

  // Turn finished: small grace for trailing updates, then read the file.
  if (msg?.id === 3 && msg?.result) {
    setTimeout(() => {
      finished = true
      clearTimeout(timer)
      console.log(`[repro] final file content from disk:\n${readFileSync(targetFile, 'utf8')}`)
      child.kill('SIGTERM')
    }, GRACE_MS)
  }
}