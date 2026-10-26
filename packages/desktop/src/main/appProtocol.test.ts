import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_ENTRY, appResponse, appUrl, contentTypeOf, devServerOrigin, isAppEntry, isAppUrl, resolveAppPath } from './appProtocol'

const root = mkdtempSync(join(tmpdir(), 'slate-app-'))
mkdirSync(join(root, 'assets'))
writeFileSync(join(root, 'index.html'), '<!doctype html>')
writeFileSync(join(root, 'assets', 'loro.wasm'), Buffer.from([0, 97, 115, 109]))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('app://slate/ (B-6)', () => {
  it('maps the entry and its assets under the renderer folder', () => {
    expect(APP_ENTRY).toBe('app://slate/index.html')
    expect(appUrl(false)).toBe('app://slate/index.html')
    expect(appUrl(true)).toBe('app://slate/index.html?lock=1')
    // C6: the self-test error screen is the same page; the failed check's id travels in the query, encoded.
    expect(appUrl({ selfTestFailed: 'POST-AES-GCM-ENC' })).toBe('app://slate/index.html?selftest-failed=POST-AES-GCM-ENC')
    expect(appUrl({ selfTestFailed: 'a&b=c' })).toBe('app://slate/index.html?selftest-failed=a%26b%3Dc')
    expect(isAppEntry(appUrl({ selfTestFailed: 'POST-ZEROIZE' }))).toBe(true)
    expect(resolveAppPath(root, 'app://slate/')).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://slate/index.html?lock=1')).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://slate/assets/loro.wasm')).toBe(join(root, 'assets', 'loro.wasm'))
    expect(resolveAppPath(root, 'app://slate/assets/a%20b.css')).toBe(join(root, 'assets', 'a b.css'))
  })

  it('refuses .. (plain or encoded), absolute paths, other hosts and other schemes', () => {
    for (const url of [
      'app://slate/%2e%2e/secret',
      'app://slate/assets/%2E%2E/%2e%2e/x',
      'app://slate/..%2fsecret',
      'app://slate/assets%5c..%5csecret',
      'app://slate//etc/passwd',
      'app://slate/%2Fetc%2Fpasswd',
      'app://slate/a%00b',
      'app://slate/%E0%A4%A',
      'app://evil/index.html',
      'file:///etc/passwd',
      'https://slate/index.html',
      'not a url',
    ])
      expect(resolveAppPath(root, url), url).toBeNull()
  })

  it('serves files with their content type and 404s anything else', async () => {
    const wasm = await appResponse(root, 'app://slate/assets/loro.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('Content-Type')).toBe('application/wasm')
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]))
    expect((await appResponse(root, 'app://slate/missing.js')).status).toBe(404)
    expect((await appResponse(root, 'app://slate/assets')).status).toBe(404)
    expect((await appResponse(root, 'app://slate/%2e%2e/x')).status).toBe(404)
    expect(contentTypeOf('a.js')).toBe('text/javascript')
    expect(contentTypeOf('a.unknown')).toBe('application/octet-stream')
  })
})

describe('isAppUrl: what counts as Slate itself (B-1, B-2)', () => {
  it('is app://slate/ and nothing else, or the dev server origin when one is given', () => {
    for (const u of [APP_ENTRY, 'app://slate/', 'app://slate/index.html?lock=1', 'app://slate/assets/x.js']) expect(isAppUrl(u), u).toBe(true)
    for (const u of ['https://example.invalid/', 'app://evil/', 'app://slate.evil/', 'app://slate:1/', 'app://x@slate/', 'file:///tmp/other.html', 'slate-blob://x', 'http://localhost:5173/', 'about:blank', '', 'not a url'])
      expect(isAppUrl(u), u).toBe(false)
    expect(isAppUrl('http://localhost:5173/?lock=1', 'http://localhost:5173')).toBe(true)
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isAppUrl('https://localhost:5173/', 'http://localhost:5173')).toBe(false)
  })

  it('trusts a dev server only in an unpackaged app, and only on loopback', () => {
    expect(devServerOrigin(false, 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(devServerOrigin(false, 'http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173')
    expect(devServerOrigin(true, 'http://localhost:5173')).toBeNull()
    expect(devServerOrigin(false, 'https://evil.invalid')).toBeNull()
    expect(devServerOrigin(false, undefined)).toBeNull()
    expect(devServerOrigin(false, 'nonsense')).toBeNull()
  })
})

describe('isAppEntry: the one page IPC trusts (B-2, review L2)', () => {
  it('is the app entry, with or without ?lock=1, and no other app://slate/ path', () => {
    for (const u of [APP_ENTRY, `${APP_ENTRY}?lock=1`, 'app://slate/']) expect(isAppEntry(u), u).toBe(true)
    for (const u of ['app://slate/assets/x.svg', 'app://slate/assets/', 'app://slate/other.html', 'app://evil/index.html', 'about:blank', '']) expect(isAppEntry(u), u).toBe(false)
    expect(isAppEntry('http://localhost:5173/?lock=1', 'http://localhost:5173')).toBe(true)
    expect(isAppEntry('http://localhost:5173/src/x.svg', 'http://localhost:5173')).toBe(false)
  })
})
