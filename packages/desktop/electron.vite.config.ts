import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', mcp: 'src/mcp/cli.ts' },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
    // The base64 build inlines Loro's wasm, so the renderer needs no wasm bundler plugin.
    resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] },
  },
})
