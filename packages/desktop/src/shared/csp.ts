/**
 * The renderer's Content-Security-Policy for a built app (audit B-4). index.html carries the
 * development policy (Vite's dev server needs `ws:`, `http://localhost:*` and React refresh's inline
 * preamble); a build replaces it with this one through the electron-vite plugin in
 * electron.vite.config.ts. Nothing is allowed by default. Scripts are the app's own files only: no
 * inline script, so an HTML node adopted from a paste cannot run an `onerror=` beside `window.slate`
 * (red team R2). Images are the app's own and note images (`slate-blob:`), never remote: a note's
 * `<img src=https://…>` would tell a third party who opened it and when (F-EL-04, red team R5). The
 * renderer reaches main only through IPC, so it needs no network. `frame-ancestors` is left out:
 * browsers ignore it in a meta tag, and nothing can frame an Electron window anyway.
 */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // TipTap and React set style attributes on nodes; styles cannot run code.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: slate-blob:",
  "font-src 'self'",
  "connect-src 'self'",
  // The renderer creates no worker; a pasted node that tried to would be refused (C5).
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

const META = /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/

/** index.html with its development policy swapped for PRODUCTION_CSP; throws if there is none to swap. */
export function withProductionCsp(html: string): string {
  if (!META.test(html)) throw new Error('index.html has no Content-Security-Policy meta tag to replace')
  return html.replace(META, `$1${PRODUCTION_CSP}$2`)
}

/**
 * C5: Trusted Types, report-only for now. `DOMParser.parseFromString` in the paste sanitiser and
 * ProseMirror's own DOM writing are the sinks that must go through a named policy first; until they do,
 * enforcing this would break pasting in a packaged build, where nobody sees the console. The full e2e run's
 * violation list is in `.agent-reports/rel-0.7.0/report-C5.md`.
 */
export const TRUSTED_TYPES_REPORT_ONLY = "require-trusted-types-for 'script'"
