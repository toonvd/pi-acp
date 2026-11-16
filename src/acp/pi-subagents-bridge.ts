/**
 * Bundled pi extension that surfaces the pi-subagents fleet to the ACP adapter.
 *
 * pi's RPC mode forwards the agent session event stream but not the in-process `pi.events`
 * bus, so an external adapter cannot see `subagent:*` events. This extension runs inside pi,
 * watches those events plus each async run's `status.json`, and republishes one snapshot per
 * run through `ctx.ui.setStatus('pi-acp:subagent:<runId>', json)` — the only extension → adapter
 * channel pi 1.3.0 offers. The adapter decodes those snapshots into ACP `subagent_update`s.
 *
 * Stopping: the adapter writes `{op:'cancel', runId}` on PI_ACP_SUBAGENT_SOCKET; this extension
 * forwards it to pi-subagents' own in-process RPC (`subagents:rpc:v1:request`, method `stop`)
 * and reports the outcome back on the same socket.
 *
 * Types are declared locally: pi injects the real API at load time and pi-acp does not depend
 * on the SDK package here.
 */

type BusHandler = (data: unknown) => void
type HookHandler = (event: unknown, ctx: unknown) => void

interface PiExtensionApi {
  on(event: string, handler: HookHandler): void
  events: {
    on(channel: string, handler: BusHandler): () => void
    off?(channel: string, handler: BusHandler): void
    emit(channel: string, data: unknown): void
  }
  appendEntry?(customType: string, data?: unknown): string
}

type ExtensionContext = {
  ui?: { setStatus?(key: string, text: string): void }
  sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined }
}

type ChildExtensionRegistration = { dispose(): void }

/** Global registry pi-subagents reads when launching children; written in-process. */
const REQUIRED_CHILD_EXT_KEY = 'pi-subagents.required-child-extensions.v1'

const ASYNC_STARTED = 'subagent:async-started'
const ASYNC_COMPLETE = 'subagent:async-complete'
const FOREGROUND_COMPLETE = 'subagent:foreground-complete'
const CHILD_STATUS = 'subagent:child-status'

const RPC_REQUEST = 'subagents:rpc:v1:request'
const RPC_REPLY_PREFIX = 'subagents:rpc:v1:reply:'

const TITLE_MAX = 512
const TEXT_MAX = 65536
const POLL_MS = 500

/** pi-subagents redacts the child task/goal to this placeholder; never show it as a title. */
const PROMPT_REDACTED = '[prompt redacted]'

function isRedacted(value: string): boolean {
  return value === PROMPT_REDACTED
}

type Run = {
  runId: string
  agent: string
  description?: string
  asyncDir?: string
  /** Parent tool-call id from `status.json`; lets the adapter pair the task text with this run. */
  toolCallId?: string
  status: string
  text: string
  last?: string
  timer?: ReturnType<typeof setInterval>
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** pi-subagents wraps bus payloads; the useful object is the inner `data` when present. */
function payloadData(value: unknown): Record<string, unknown> {
  const outer = record(value)
  const inner = record(outer.data)
  return Object.keys(inner).length ? inner : outer
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** `status.json` text: the tail of the most recent step activity, collapsed to one line. */
function statusText(status: Record<string, unknown>): string {
  const steps = Array.isArray(status.steps) ? status.steps.map(record) : []
  const lines: string[] = []
  for (const step of steps) {
    const agent = str(step.agent) ?? 'agent'
    const state = str(step.status) ?? 'running'
    const recent = Array.isArray(step.recentTools) ? step.recentTools.map(str).filter(Boolean) : []
    lines.push(`${agent}: ${state}${recent.length ? ` (${recent.slice(-1)[0]})` : ''}`)
  }
  const error = str(status.error)
  if (error) lines.push(`error: ${collapse(error)}`)
  return clamp(lines.join('\n'), TEXT_MAX)
}

function runStatus(status: Record<string, unknown>): string {
  const state = str(status.state) ?? str(status.status) ?? 'running'
  if (state === 'completed' || state === 'failed' || state === 'cancelled') return state
  return 'running'
}

export default function (pi: PiExtensionApi): void {
  const socketPath = process.env.PI_ACP_SUBAGENT_SOCKET
  const runs = new Map<string, Run>()
  let ctx: ExtensionContext | undefined
  let control: import('node:net').Socket | undefined
  let fsRegistration: ChildExtensionRegistration | undefined

  /**
   * Make every subagent child load the fs bridge so its writes flow to the client
   * (and Zed's review panel) instead of being applied silently to disk. pi-subagents
   * reads a global registry when launching children and injects each entry as a
   * `--extension` arg; the child already inherits PI_ACP_FS_SOCKET. We write that
   * registry directly (same runtime) so no pi-subagents import is needed. Guarded so
   * any failure simply keeps today's behaviour.
   */
  const registerFsBridgeForChildren = async (sessionCtx: ExtensionContext | undefined): Promise<void> => {
    if (fsRegistration) return
    const sm = sessionCtx?.sessionManager
    // Match pi-subagents' resolveCurrentSessionId: getSessionFile() ?? getSessionId().
    // The launch ctx may resolve to either, so register under both when they differ.
    const keys = [...new Set([sm?.getSessionFile?.(), sm?.getSessionId?.()].filter((k): k is string => typeof k === 'string' && k.length > 0))]
    if (keys.length === 0) return
    try {
      const { fileURLToPath } = await import('node:url')
      const { join, dirname } = await import('node:path')
      const { realpathSync, statSync } = await import('node:fs')
      const fsBridgePath = realpathSync(join(dirname(fileURLToPath(import.meta.url)), 'pi-fs-bridge.js'))
      statSync(fsBridgePath) // ensure the file is present before registering it
      const key = Symbol.for(REQUIRED_CHILD_EXT_KEY)
      const root = globalThis as Record<symbol, unknown>
      const existing = root[key] as { version: number; bySession: Map<string, unknown> } | undefined
      const store = existing ?? { version: 1, bySession: new Map<string, unknown>() }
      root[key] = store
      const snapshot = Object.freeze([Object.freeze({ id: 'pi-acp-fs-bridge', path: fsBridgePath })])
      for (const k of keys) store.bySession.set(k, snapshot)
      fsRegistration = {
        dispose() {
          for (const k of keys) if (store.bySession.get(k) === snapshot) store.bySession.delete(k)
        }
      }
    } catch {
      /* any failure keeps today's behaviour (children write locally, no review surface) */
    }
  }

  const setStatus = (key: string, value: string): void => {
    try {
      ctx?.ui?.setStatus?.(key, value)
    } catch {
      /* UI transport may already be detached. */
    }
  }

  const emitRun = (run: Run): void => {
    const description = run.description && !isRedacted(run.description) ? run.description : undefined
    const snapshot = JSON.stringify({
      version: 1,
      runId: run.runId,
      agent: run.agent,
      title: clamp(collapse(description ?? run.agent), TITLE_MAX),
      ...(description ? { description: clamp(collapse(description), TITLE_MAX) } : {}),
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      text: clamp(run.text, TEXT_MAX)
    })
    if (snapshot === run.last) return
    run.last = snapshot
    setStatus(`pi-acp:subagent:${run.runId}`, snapshot)
  }

  const stopPolling = (run: Run): void => {
    if (run.timer) {
      clearInterval(run.timer)
      run.timer = undefined
    }
  }

  const poll = (run: Run): void => {
    if (!run.asyncDir || run.timer) return
    run.timer = setInterval(() => {
      void (async () => {
        try {
          const { readFile } = await import('node:fs/promises')
          const status = JSON.parse(await readFile(`${run.asyncDir}/status.json`, 'utf8')) as unknown
          const value = record(status)
          run.status = runStatus(value)
          run.text = statusText(value)
          run.toolCallId = str(value.toolCallId) ?? run.toolCallId
          emitRun(run)
          if (run.status !== 'running') stopPolling(run)
        } catch {
          stopPolling(run)
        }
      })()
    }, POLL_MS)
    run.timer.unref?.()
  }

  const upsert = (data: Record<string, unknown>, status: string): void => {
    const runId = str(data.runId) ?? str(data.id)
    if (!runId) return
    const existing = runs.get(runId)
    const run: Run = existing ?? { runId, agent: str(data.agent) ?? 'subagent', status, text: '' }
    run.agent = str(data.agent) ?? run.agent
    run.description = str(data.description) ?? str(data.task) ?? run.description
    run.asyncDir = str(data.asyncDir) ?? run.asyncDir
    if (status !== 'running') run.status = status
    runs.set(runId, run)
    emitRun(run)
    if (run.status === 'running') poll(run)
    else stopPolling(run)
  }

  const handle = (event: string): BusHandler => {
    return value => {
      try {
        const data = payloadData(value)
        if (event === ASYNC_STARTED) upsert(data, 'running')
        else if (event === ASYNC_COMPLETE) upsert(data, 'completed')
        else if (event === FOREGROUND_COMPLETE) upsert(data, 'completed')
        else if (event === CHILD_STATUS) {
          const status = str(data.status) ?? 'running'
          upsert(data, status === 'completed' || status === 'failed' ? status : 'running')
        }
      } catch {
        /* a dropped event self-heals on the next one */
      }
    }
  }

  for (const event of [ASYNC_STARTED, ASYNC_COMPLETE, FOREGROUND_COMPLETE, CHILD_STATUS]) {
    pi.events.on(event, handle(event))
  }

  pi.on('session_start', (_event, sessionCtx) => {
    ctx = sessionCtx as ExtensionContext
    void registerFsBridgeForChildren(ctx)
  })

  pi.on('session_shutdown', () => {
    for (const run of runs.values()) stopPolling(run)
    runs.clear()
    setStatus('pi-acp:subagent:clear', '1')
    control?.destroy()
    control = undefined
    fsRegistration?.dispose()
    fsRegistration = undefined
  })

  // Cancel channel: the adapter asks for a run to stop; pi-subagents' in-process RPC does the work.
  if (socketPath) {
    void (async () => {
      try {
        const { createConnection } = await import('node:net')
        const socket = createConnection(socketPath)
        control = socket
        socket.setEncoding('utf8')
        let buffer = ''
        socket.on('data', (chunk: string) => {
          buffer += chunk
          let newline: number
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.trim()) void handleControl(line, socket)
          }
        })
        socket.on('error', () => {
          control = undefined
        })
      } catch {
        control = undefined
      }
    })()
  }

  async function handleControl(line: string, socket: import('node:net').Socket): Promise<void> {
    let request: { op?: unknown; runId?: unknown } = {}
    try {
      request = record(JSON.parse(line)) as { op?: unknown; runId?: unknown }
      const runId = str(request.runId)
      if (request.op !== 'cancel' || !runId) throw new Error('Unsupported control request')
      const result = await stopRun(runId)
      socket.write(JSON.stringify({ runId, ...result }) + '\n')
    } catch (error) {
      socket.write(
        JSON.stringify({
          runId: str(request.runId) ?? '',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }) + '\n'
      )
    }
  }

  function stopRun(runId: string): Promise<{ ok: boolean; error?: string }> {
    const requestId = `pi-acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pi.events.off?.(`${RPC_REPLY_PREFIX}${requestId}`, onReply)
        resolve({ ok: false, error: 'Subagent stop timed out' })
      }, 10_000)
      timer.unref?.()
      const onReply = (value: unknown): void => {
        clearTimeout(timer)
        const reply = record(value)
        if (reply.success === true) {
          const run = runs.get(runId)
          if (run) {
            run.status = 'cancelled'
            emitRun(run)
            stopPolling(run)
          }
          resolve({ ok: true })
          return
        }
        const error = record(reply.error)
        resolve({ ok: false, error: str(error.message) ?? 'Subagent stop failed' })
      }
      pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, onReply)
      try {
        pi.events.emit(RPC_REQUEST, { version: 1, requestId, method: 'stop', params: { id: runId } })
      } catch (error) {
        clearTimeout(timer)
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
}
