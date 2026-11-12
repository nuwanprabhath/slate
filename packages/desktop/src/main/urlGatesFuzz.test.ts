import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep, isAbsolute } from 'node:path'
import { remoteTransport } from '@slate/sync'
import { fcParams, fcRuns } from '../../test/fuzz'
import { hostileUrl } from '../../test/fuzzHtml'
import { safeExternalUrl } from './openExternal'
import { isAppEntry, isAppUrl, resolveAppPath } from './appProtocol'
import { blobNameFromUrl } from './blobs'
import { DocStore } from './store'
import { isAllowedRemote } from '../shared/gitRemote'

const ROOT = join(tmpdir(), 'slate-renderer-root', 'out')

/** Path segments that try to climb out: encoded, doubled, backslashed, NUL, mixed separators. */
const segment = fc.constantFrom(
  '..', '.', '', '%2e%2e', '%2E%2e', '.%2e', '%2e.', '%252e%252e', '..%2f', '..%5c', '%2f', '%5c', '\\', '..\\..', '%00', '\u0000', '....', '.../',
  '%c0%ae%c0%ae', '%uff0e%uff0e', '．．', 'assets', 'index.html', 'a.js', 'x%20y', '%', '%zz', '/', '//', '?', '#', 'etc', 'passwd'
)
const appPath = fc.array(segment, { maxLength: 8 }).map((s) => s.join('/'))
const appLike = fc.oneof(
  fc.tuple(fc.constantFrom('app://slate/', 'app://slate', 'APP://slate/', 'app://SLATE/', 'app://slate.evil/', 'app://user@slate/', 'app://slate:80/', 'app:/slate/', 'app:slate/', 'app://evil/'), appPath, fc.constantFrom('', '?x=1', '#h', '?a=../..')).map((p) => p.join('')),
  hostileUrl,
  fc.string({ maxLength: 60 })
)

const inside = (full: string): boolean => {
  const rel = relative(ROOT, full)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !full.includes('\0')
}

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('address and path gates (F4b properties 1 to 3, 5)', () => {
  it('T-F4B-08: safeExternalUrl never throws and gives null or an https/mailto URL that parses', () => {
    fc.assert(
      fc.property(fc.oneof(hostileUrl, fc.string({ maxLength: 60 }), fc.constantFrom<unknown>(null, 1, {}, ['https://a.b'])), (value) => {
        const out = safeExternalUrl(value)
        expect(out === null || typeof out === 'string').toBe(true)
        if (out === null) return
        const u = new URL(out)
        expect(['https:', 'mailto:']).toContain(u.protocol)
        if (u.protocol === 'https:') expect(u.hostname).not.toBe('')
      }),
      fcParams
    )
  })

  it('T-F4B-09: resolveAppPath gives null or a path strictly inside the root, whatever the traversal spelling', () => {
    fc.assert(
      fc.property(appLike, (url) => {
        const full = resolveAppPath(ROOT, url)
        expect(full === null || typeof full === 'string').toBe(true)
        if (full === null) return
        expect(inside(full), `${url} -> ${full}`).toBe(true)
        expect(full.startsWith(ROOT + sep)).toBe(true)
      }),
      fcParams
    )
  })

  it('T-F4B-10: isAppUrl and isAppEntry accept only the app://slate origin', () => {
    fc.assert(
      fc.property(appLike, (url) => {
        const app = isAppUrl(url)
        if (app) {
          const u = new URL(url)
          expect(u.protocol).toBe('app:')
          expect(u.host).toBe('slate')
          expect(u.username + u.password).toBe('')
        }
        if (isAppEntry(url)) expect(app).toBe(true)
        expect(typeof app).toBe('boolean')
      }),
      fcParams
    )
  })

  it('T-F4B-11: blobNameFromUrl gives null or a bare name with no separator, .. or NUL', () => {
    const blobLike = fc.oneof(
      fc.tuple(fc.constantFrom('slate-blob://blob/', 'slate-blob://BLOB/', 'slate-blob://evil/', 'slate-blob:blob/', 'SLATE-BLOB://blob/'), appPath).map((p) => p.join('')),
      fc.tuple(fc.constantFrom('slate-blob://blob/', 'slate-blob://blob/x/../'), fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64 }), fc.constantFrom('.png', '.png/..', '.png%2f..', '.PNG', '.toolong', '')).map((p) => p.join('')),
      hostileUrl
    )
    fc.assert(
      fc.property(blobLike, (url) => {
        const name = blobNameFromUrl(url)
        expect(name === null || typeof name === 'string').toBe(true)
        if (name === null) return
        expect(name).not.toMatch(/[/\\]/)
        expect(name).not.toContain('..')
        expect(name).not.toContain('\0')
      }),
      fcParams
    )
  })

  it('T-F4B-12: every accepted remote records only a host-level id: no credential reaches transport_observations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-f4b-'))
    dirs.push(dir)
    const store = new DocStore(join(dir, 'slate.db'))
    const secret = fc.constantFrom('alice', 'tok3n', 'ghpSECRET', 'p%40ss')
    const remote = fc.oneof(
      fc.tuple(fc.constantFrom('https://', 'ssh://', 'git+ssh://', 'HTTPS://'), secret, secret, fc.constantFrom('github.com', 'Git.Example.com', 'h'), fc.constantFrom('', ':22', ':8443'), fc.constantFrom('/o/r.git', '/o/r?token=QQQ', '/~x')).map(
        ([s, u, p, h, po, pa]) => ({ url: `${s}${u}:${p}@${h}${po}${pa}`, secrets: [u, p, 'QQQ'] })
      ),
      fc.tuple(secret, fc.constantFrom('github.com', 'gitlab.com'), fc.constantFrom('o/r.git', 'r')).map(([u, h, pa]) => ({ url: `${u}@${h}:${pa}`, secrets: [u] }))
    )
    try {
      fc.assert(
        fc.property(remote, ({ url, secrets }) => {
          if (!isAllowedRemote(url, { allowLocal: false })) return
          const t = remoteTransport(url)
          if (t === null) return
          store.recordTransport({ remote: t.remote, transport: t.kind === 'ssh' ? 'ssh' : 'tls', kex: null, pq: 'unknown', source: 'test-connection', at: 1 })
        }),
        fcRuns(4, 200)
      )
      const rows = store.transportObservations()
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect(r.remote).not.toMatch(/[/@?]/)
        for (const s of ['alice', 'tok3n', 'ghpsecret', 'p%40ss', 'qqq']) expect(r.remote.toLowerCase()).not.toContain(s)
      }
    } finally {
      store.close()
    }
  })
})
