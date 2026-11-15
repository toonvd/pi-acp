import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/acp/pi-mcp-bridge.ts', 'src/acp/pi-fs-bridge.ts', 'src/acp/pi-subagents-bridge.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  // pi resolves @earendil-works/pi-coding-agent against its own copy when loading
  // the bridge (extensions/loader.js aliases it), so it must stay an external import.
  external: ['@earendil-works/pi-coding-agent'],
  banner: {
    js: '#!/usr/bin/env node'
  }
})
