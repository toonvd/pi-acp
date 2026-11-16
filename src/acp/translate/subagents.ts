import type { PlanEntry } from '@agentclientprotocol/sdk'

/**
 * Maps pi-subagents run snapshots (published by the bundled `pi-subagents-bridge` extension
 * through `ctx.ui.setStatus`) onto ACP subagent updates.
 *
 * Zed renders one card per announced subagent, streams the child's content under the child
 * session id, and shows a Stop button only when `capabilities.cancel` is present. The card's
 * activity `state` is a tagged union we cannot build from SDK 0.26.0, so it is left undefined
 * (unchanged) rather than cleared.
 */

export type SubagentSnapshot = {
  runId: string
  agent: string
  title: string
  description?: string
  /** Parent tool-call id, surfaced so the adapter can pair the run with its task text. */
  toolCallId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  text: string
}

const TITLE_MAX = 512
const TEXT_MAX = 65536

export const SUBAGENT_STATUS_KEY_PREFIX = 'pi-acp:subagent:'
export const SUBAGENT_STATUS_CLEAR_KEY = 'pi-acp:subagent:clear'

/** Child ACP session id for a pi-subagents run. Stable across snapshots. */
export function subagentSessionId(runId: string): string {
  return `pi-subagent-${runId}`
}

/** True when an ACP session id names a subagent this adapter announced. */
export function isSubagentSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pi-subagent-')
}

/** pi-subagents run id encoded in a child session id. */
export function subagentRunId(sessionId: string): string | null {
  return isSubagentSessionId(sessionId) ? sessionId.slice('pi-subagent-'.length) || null : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** Parse a `setStatus` payload. Returns null for anything malformed rather than throwing. */
export function parseSubagentSnapshot(text: unknown): SubagentSnapshot | null {
  if (typeof text !== 'string' || !text.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const runId = str(raw.runId)
  if (!runId) return null
  const agent = str(raw.agent) ?? 'subagent'
  const status = str(raw.status)
  const normalised: SubagentSnapshot['status'] =
    status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'running'
  return {
    runId,
    agent,
    title: clamp(str(raw.title) ?? agent, TITLE_MAX),
    ...(str(raw.description) ? { description: clamp(String(str(raw.description)), TITLE_MAX) } : {}),
    ...(str(raw.toolCallId) ? { toolCallId: String(str(raw.toolCallId)) } : {}),
    status: normalised,
    text: clamp(typeof raw.text === 'string' ? raw.text : '', TEXT_MAX)
  }
}

/**
 * The parent-side `subagent_update` announcing (or updating) a run. `cancel` is only
 * advertised while the run can still be stopped.
 */
export function snapshotToSubagentUpdate(
  snapshot: SubagentSnapshot,
  options: { cancel: boolean }
): Record<string, unknown> {
  return {
    sessionUpdate: 'subagent_update',
    sessionId: subagentSessionId(snapshot.runId),
    title: snapshot.title,
    ...(snapshot.description ? { description: snapshot.description } : {}),
    ...(options.cancel ? { capabilities: { cancel: {} } } : {})
  }
}

/** Text to append to the child session: only what the previous snapshot had not reported yet. */
export function snapshotTextDelta(previous: string, next: string): string {
  if (!next) return ''
  if (!previous) return next
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  // The child rewrote its tail (tool lines get replaced); resend the tail only.
  return `\n${next.split('\n').slice(-1)[0] ?? ''}\n`
}

/** A subagent run reduced to what a plan entry needs. */
export type SubagentRunInfo = { title: string; status: string }

/**
 * Render the live subagent fleet as a full-replacement ACP plan.
 *
 * Zed renders the plan panel for every client (unlike subagent cards, which it gates behind its
 * staff-only `acp-beta` flag), so this is the universal channel for surfacing the fleet. Running
 * runs sort first so the live work is at the top; the plan is replaced wholesale on each update.
 * Returns null when there is nothing to show.
 */
export function subagentRunsToPlan(runs: ReadonlyMap<string, SubagentRunInfo>): PlanEntry[] | null {
  const running: PlanEntry[] = []
  const done: PlanEntry[] = []
  for (const { title, status } of runs.values()) {
    const entry: PlanEntry = {
      content: title,
      priority: status === 'running' ? 'medium' : 'low',
      status: status === 'running' ? 'in_progress' : 'completed'
    }
    ;(status === 'running' ? running : done).push(entry)
  }
  const entries = running.concat(done)
  return entries.length ? entries : null
}
