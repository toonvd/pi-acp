/**
 * Permission gate for edit/write tool calls.
 *
 * pi-acp spawns pi with `--extension <this file>`. The handler intercepts every
 * `tool_call` BEFORE it executes and asks the ACP client (via pi's extension UI
 * `confirm`) whether to allow it. The confirm message carries an unambiguous
 * marker (`pi-acp:toolcall=<toolCallId>`) that the adapter parses to correlate
 * the prompt with the already-emitted ACP tool card and attach a full-file diff
 * preview.
 *
 * Only top-level `edit`/`write` calls are gated: subagent child calls
 * (`parentToolCallId` set) are skipped so a parallel fan-out does not serialize
 * into a prompt storm. `PI_ACP_PERMISSION_GATE=0` disables the gate entirely.
 *
 * No imports beyond node builtins: pi loads this file directly (jiti handles .ts,
 * node handles the bundled .js), so it must stay dependency-free.
 */

const GATED_TOOLS = new Set(['edit', 'write'])
const DISABLE_ENV = 'PI_ACP_PERMISSION_GATE'

interface GateApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<unknown>): unknown
}

interface GateCtx {
  ui?: { confirm?: (title: string, message: string, options?: { timeout?: number }) => Promise<unknown> }
}

export default function (pi: GateApi): void {
  if (process.env[DISABLE_ENV] === '0') return
  pi.on('tool_call', async (event, ctx) => {
    try {
      const record = event as {
        toolName?: unknown
        toolCallId?: unknown
        parentToolCallId?: unknown
        input?: unknown
      }
      const toolName = typeof record.toolName === 'string' ? record.toolName : ''
      if (!GATED_TOOLS.has(toolName)) return undefined
      // Do not gate child calls made by other tools (e.g. subagent fan-out):
      // they would serialize into a prompt storm.
      if (record.parentToolCallId !== undefined) return undefined
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : ''
      if (!toolCallId) return undefined

      const ui = (ctx as GateCtx | undefined)?.ui
      if (typeof ui?.confirm !== 'function') return undefined

      // Pass an explicit timeout: pi only wires abort/timeout into its confirm when
      // options are provided, and without one a never-answering client would hang the
      // tool forever (the adapter races the same ceiling and replies `cancelled`).
      // pi resolves `false` on timeout, which blocks the tool call.
      const confirmed = await ui.confirm(`Allow ${toolName}?`, buildMessage(toolName, record.input, toolCallId), {
        timeout: 300_000
      })
      if (confirmed === true) return undefined
      return { block: true, reason: `User rejected this ${toolName} in the ACP client` }
    } catch (err) {
      // Never fail the turn because of a gate bug: default to allowing.
      console.error('[pi-permission-gate] internal error; allowing tool call', err)
      return undefined
    }
  })
}

function buildMessage(toolName: string, input: unknown, toolCallId: string): string {
  const record = input as { path?: unknown; file_path?: unknown; edits?: unknown } | null | undefined
  const path =
    typeof record?.path === 'string'
      ? record.path
      : typeof record?.file_path === 'string'
        ? record.file_path
        : '(unknown path)'
  const lines = [`pi-acp:toolcall=${toolCallId}`]
  if (toolName === 'edit') {
    const count = editCount(record)
    lines.push(`Edit ${path} (${count} edit${count === 1 ? '' : 's'})`)
  } else {
    lines.push(`Write ${path}`)
  }
  return lines.join('\n')
}

function editCount(record: { edits?: unknown } | null | undefined): number {
  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }
  // pi normalizes a single edit object into a one-element array; count it as one.
  if (Array.isArray(edits)) return edits.length
  const single = edits as { oldText?: unknown; newText?: unknown } | null | undefined
  if (typeof single?.oldText === 'string' && typeof single?.newText === 'string') return 1
  return 0
}
