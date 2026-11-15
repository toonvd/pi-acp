/**
 * Ambient types for the pi SDK that pi-fs-bridge.ts imports at runtime.
 *
 * The pi extension loader aliases `@earendil-works/pi-coding-agent` to pi's own copy
 * (dist/core/extensions/loader.js), so the package is never installed next to pi-acp.
 * This declaration mirrors the small SDK surface the bridge uses and is type-only:
 * it is never emitted and never loaded at runtime.
 */

declare module '@earendil-works/pi-coding-agent' {
  export type WriteOperations = {
    writeFile: (absolutePath: string, content: string) => Promise<void>
    mkdir: (dir: string) => Promise<void>
  }

  export interface WriteToolOptions {
    operations?: WriteOperations
  }

  export interface ToolDefinition {
    name: string
    label: string
    description: string
    parameters: unknown
    execute: (...args: unknown[]) => unknown
  }

  export interface ExtensionAPI {
    on(event: 'session_shutdown', handler: () => void): () => void
    registerTool(tool: ToolDefinition): void
  }

  export type EditOperations = {
    readFile: (absolutePath: string) => Promise<Buffer>
    writeFile: (absolutePath: string, content: string) => Promise<void>
    access: (absolutePath: string) => Promise<void>
  }

  export interface EditToolOptions {
    operations?: EditOperations
  }

  export function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition
  export function createWriteToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition
}
