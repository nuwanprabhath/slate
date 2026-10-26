import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { withProductionCsp } from './src/shared/csp'

/**
 * Audit C2: main (index.ts) loads @slate/native from out/native/slate_native.node; asarUnpack keeps
 * it outside app.asar. The host's prebuild is copied here; electron-builder's beforePack swaps in
 * the target arch's and refuses to package without one. A checkout without the addon still builds
 * and runs, reporting the module as not available.
 */
function nativeAddon(): Plugin {
  return {
    name: 'slate-native-addon',
    closeBundle() {
      const target = `${process.platform}-${process.arch}`
      const from = resolve(__dirname, '../native/prebuilds', target, 'slate_native.node')
      const to = resolve(__dirname, 'out/native/slate_native.node')
      rmSync(to, { force: true })
      if (!existsSync(from)) {
        console.warn(`@slate/native: no ${target} prebuild (npm run -w @slate/native build); the app will report the module as not available`)
        return
      }
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    },
  }
}

/** A build gets the production CSP (src/shared/csp.ts); the dev server keeps index.html's, which hot reload needs. */
function productionCsp(): Plugin {
  return { name: 'slate-production-csp', apply: 'build', transformIndexHtml: (html) => withProductionCsp(html) }
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [nativeAddon()],
    // C12 N2: only the packaged e2e harness's build (`npm run dist:e2e`, --mode e2e) obeys SLATE_E2E;
    // a release scrubs it (src/main/testHooks.ts). Decided here, at build time, not by the environment.
    define: { __SLATE_E2E_BUILD__: JSON.stringify(mode === 'e2e') },
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', mcp: 'src/mcp/cli.ts', 'import-cli': 'src/mcp/importCli.ts' },
      },
    },
  },
  preload: {},
  renderer: {
    // Loro's wasm ships as its own .wasm asset (the bundler build), not base64 inside the JS
    // bundle: with it inlined, unrelated bundle edits made some launches run Loro ~3x slower for
    // the whole process (page open ~115 ms vs ~38 ms). As an asset it is fast (37-42 ms over 12
    // runs). The renderer targets Electron's Chromium, which has top-level await natively.
    plugins: [react(), wasm(), productionCsp()],
    build: { target: 'esnext' },
  },
}))
