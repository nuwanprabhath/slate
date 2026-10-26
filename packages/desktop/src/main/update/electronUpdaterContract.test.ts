import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// electronBackend's cache check (review F2) reads AppUpdater's private `updateInfoAndProvider`.
// These read the installed class itself, not a mock, so an upgrade that renames it fails here
// instead of silently turning AppImage updates off (review R2).
const desktop = join(__dirname, '..', '..', '..')
const require = createRequire(join(desktop, 'package.json'))

describe('electron-updater contract (review R2)', () => {
  it('is pinned to an exact version', () => {
    const spec = (JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['electron-updater']
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('caches the checked update in updateInfoAndProvider, and downloads from it', () => {
    // The installed AppUpdater's own source: loading it needs a running Electron app (session).
    const file = require.resolve('electron-updater/out/AppUpdater')
    const text = readFileSync(file, 'utf8')
    const method = (name: string) => {
      const start = text.indexOf(`    ${name}(`)
      expect(start, `${name} in ${file}`).toBeGreaterThan(-1)
      return text.slice(start, text.indexOf('\n    }\n', start))
    }
    // The constructor declares it, a check stores into it, and downloadUpdate reads it on entry.
    expect(method('constructor')).toMatch(/this\.updateInfoAndProvider = null/)
    expect(text).toMatch(/this\.updateInfoAndProvider = result;/)
    expect(method('downloadUpdate')).toMatch(/= this\.updateInfoAndProvider;/)
    expect(method('downloadUpdate')).toMatch(/updateInfoAndProvider\.info/)
  })
})
