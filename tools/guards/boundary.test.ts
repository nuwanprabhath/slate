import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, read, ROOT, walk } from './repo'

/**
 * Audit C8 (§4.4, §6.7): the Electron boundary and credential storage, checked over the source text
 * so that neither can drift back. The lint rules catch the same patterns at the edit; these see the
 * whole tree at once and cannot be switched off by a disable comment.
 */
const SYNC_SAFE_STORAGE = /\.\s*(encryptString|decryptString|isEncryptionAvailable)\s*\(/

const sources = readdirSync(join(ROOT, 'packages'))
  .flatMap((pkg) => walk(`packages/${pkg}/src`, ['.ts', '.tsx']))
  .filter((f) => !isTestFile(f))

describe('credential storage (B-5)', () => {
  it('criterion 2: no synchronous safeStorage call anywhere in src/', () => {
    const hits = sources.filter((f) => SYNC_SAFE_STORAGE.test(read(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    expect(hits.map((f) => `${f}: use the async SecretStorage from src/main/secretStorage.ts`)).toEqual([])
  })

  it('the detection sees the pre-C8 calls (self-test)', () => {
    for (const s of ['p.safeStorage.encryptString(x)', 'storage.decryptString(raw)', 'safeStorage.isEncryptionAvailable()', 'ss . encryptString (x)']) expect(SYNC_SAFE_STORAGE.test(s), s).toBe(true)
    for (const s of ['ss.encryptStringAsync(x)', 'ss.isAsyncEncryptionAvailable()']) expect(SYNC_SAFE_STORAGE.test(s), s).toBe(false)
  })

  it('only secretStorage.ts names safeStorage', () => {
    const hits = sources.filter((f) => f !== 'packages/desktop/src/main/secretStorage.ts' && /\bsafeStorage\b/.test(read(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\/|`[^`]*`/gm, '')))
    expect(hits).toEqual([])
  })

  it('T-B-06: the MSAL token cache is never written in plain text (the fallback branch is gone)', () => {
    const auth = read('packages/desktop/src/main/onenote/auth.ts')
    const start = auth.indexOf('export function encryptedCachePlugin')
    expect(start, 'encryptedCachePlugin in onenote/auth.ts').toBeGreaterThan(-1)
    const plugin = auth.slice(start, auth.indexOf('\n}\n', start))
    // The plugin persists only through the sealed SecretFile it is given.
    expect(plugin).toMatch(/store\.set\(/)
    for (const plain of [/writeFile/, /renameSync/, /toString\(\s*['"]utf8['"]\s*\)/, /Buffer\.from\(\s*json/, /unencrypted/i]) expect(plugin, String(plain)).not.toMatch(plain)
    expect(auth).not.toMatch(/stored unencrypted/i)
  })
})

describe('every window gets the boundary guards (B-1, B-3)', () => {
  it('the window factory refuses to run before installBoundaryGuards, ahead of new BrowserWindow', () => {
    const windows = read('packages/desktop/src/main/windows.ts')
    const create = windows.slice(windows.indexOf('export function createWindow'))
    expect(create.indexOf('boundaryGuardsInstalled()')).toBeGreaterThan(-1)
    expect(create.indexOf('boundaryGuardsInstalled()')).toBeLessThan(create.indexOf('new BrowserWindow'))
  })

  it('index.ts installs them before it opens the first window and before IPC', () => {
    const index = read('packages/desktop/src/main/index.ts')
    const install = index.indexOf('installBoundaryGuards(')
    expect(install).toBeGreaterThan(-1)
    for (const later of ['createWindow(', 'createIpc(']) expect(install, later).toBeLessThan(index.indexOf(later))
  })

  it('IPC checks the sender frame against Slate\'s own page (B-2)', () => {
    const guard = read('packages/desktop/src/main/ipcGuard.ts')
    const create = guard.slice(guard.indexOf('export function createIpc'))
    expect(create).toMatch(/isTrustedSender\(/)
    expect(create).toMatch(/throw new UntrustedSender\(\)/)
  })
})
