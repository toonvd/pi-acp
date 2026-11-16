/**
 * Capabilities that the ACP SDK's initialize schema does not model yet.
 *
 * The SDK validates `clientCapabilities` against its own schema and silently strips
 * unknown keys, so a newer capability like `subagents` never reaches `PiAcpAgent.initialize`.
 * The entrypoint (index.ts) inspects the raw initialize request before the SDK validates it
 * and records which of these capabilities the client advertised; this module holds the
 * detection logic so it stays unit-testable.
 */

export interface InitializeMessageLike {
  method?: unknown
  params?: { clientCapabilities?: { subagents?: unknown } }
}

/** True when the raw initialize request advertised the `subagents` client capability. */
export function detectSubagentsCapability(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as InitializeMessageLike
  return m.method === 'initialize' && m.params?.clientCapabilities?.subagents !== undefined
}
