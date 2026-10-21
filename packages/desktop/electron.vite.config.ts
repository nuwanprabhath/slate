import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'

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
    // Loro's wasm ships as its own .wasm asset (the bundler build), not base64 inside the JS
    // bundle: with it inlined, unrelated bundle edits made some launches run Loro ~3x slower for
    // the whole process (page open ~115 ms vs ~38 ms). As an asset it is fast (37-42 ms over 12
    // runs). The renderer targets Electron's Chromium, which has top-level await natively.
    plugins: [react(), wasm()],
    build: { target: 'esnext' },
  },
})
