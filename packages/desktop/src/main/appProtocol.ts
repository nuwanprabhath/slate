import { readFile, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

/**
 * The packaged renderer is served from `app://slate/` instead of `file://` (audit B-6), so the
 * `grantFileProtocolExtraPrivileges` fuse can be off and the page's origin is one the app owns.
 */
export const APP_SCHEME = 'app'
export const APP_ORIGIN = 'app://slate'
export const APP_ENTRY = `${APP_ORIGIN}/index.html`

/** Standard + secure: same-origin rules, `'self'` in the CSP and fetch() (the wasm) all work as on https. */
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, codeCache: true } as const

/**
 * Whether `raw` is a page of Slate itself: `app://slate/…`, or the dev server's origin when one is
 * given (`npm run dev`). Navigation guards (hardening.ts) and IPC sender checks (ipcGuard.ts) use it.
 */
export function isAppUrl(raw: string, devServer: string | null = null): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  // `app:` is not a WHATWG special scheme, so its `origin` is "null"; compare its parts instead.
  if (u.protocol === `${APP_SCHEME}:`) return u.host === 'slate' && u.username === '' && u.password === ''
  return devServer !== null && (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === devServer
}

/**
 * Whether `raw` is the app entry itself (`/` or `/index.html`, any query): the one document IPC
 * trusts (B-2). Another app:// file (an asset, a 404 page) carries no CSP and must not get IPC.
 */
export function isAppEntry(raw: string, devServer: string | null = null): boolean {
  if (!isAppUrl(raw, devServer)) return false
  try {
    return ['/', '/index.html'].includes(new URL(raw).pathname)
  } catch {
    return false
  }
}

/**
 * The dev server a window may load, or null: never in a packaged app (an environment variable must
 * not point a release at another page that would get the preload), and only on loopback.
 */
export function devServerOrigin(packaged: boolean, raw: string | undefined): string | null {
  if (packaged || !raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null
    return u.origin
  } catch {
    return null
  }
}

/** The lock screen is the same page with `?lock=1`. */
/**
 * Which screen a window shows: the notes (false), the lock screen (true), or the power-up self-test's error
 * screen, which names the first failed check (C6, audit S-6). All three are the one app page.
 */
export type PageKind = boolean | { selfTestFailed: string }

export function pageQuery(page: PageKind): string {
  if (typeof page === 'object') return `?selftest-failed=${encodeURIComponent(page.selfTestFailed)}`
  return page ? '?lock=1' : ''
}

export function appUrl(page: PageKind): string {
  return APP_ENTRY + pageQuery(page)
}

/**
 * The file under `root` that `url` names, or null. Works on the raw string rather than a parsed URL,
 * so an encoded `..` (`%2e%2e`, `%2f`, `%5c`) is seen and refused instead of being folded away.
 */
export function resolveAppPath(root: string, url: string): string | null {
  const m = /^app:\/\/slate(\/[^?#]*)?(?:[?#].*)?$/.exec(url)
  if (!m) return null
  let path: string
  try {
    path = decodeURIComponent(m[1] ?? '/')
  } catch {
    return null
  }
  if (path === '/' || path === '') path = '/index.html'
  if (path.includes('\0') || path.includes('\\') || path.includes('//')) return null
  const parts = path.slice(1).split('/')
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null
  const full = join(root, ...parts)
  return full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

export function contentTypeOf(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const notFound = () => new Response('Not found', { status: 404 })

/** What `protocol.handle('app', …)` answers: only regular files under `root`. */
export async function appResponse(root: string, url: string): Promise<Response> {
  const path = resolveAppPath(root, url)
  if (!path) return notFound()
  try {
    if (!(await stat(path)).isFile()) return notFound()
    return new Response(await readFile(path), { headers: { 'Content-Type': contentTypeOf(path), 'X-Content-Type-Options': 'nosniff' } })
  } catch {
    return notFound()
  }
}
