import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vaultNative } from './native'
import { parsePreunlock, readPreunlock, signPreunlock, verifyPreunlock, writePreunlock, type PreunlockContent } from './preunlock'

const content: PreunlockContent = {
  themeId: 'folio',
  motion: 'auto',
  systemTitleBar: false,
  idleMinutes: 15,
  lockOnSleep: true,
  lockOnScreenLock: true,
  quickUnlock: false,
}

describe('preunlock.json', () => {
  const k = vaultNative().keyRandom()

  it('verifies under K_prefs and fails under another key', () => {
    const json = signPreunlock(content, k)
    expect(verifyPreunlock(json, k)).toBe(true)
    expect(verifyPreunlock(json, vaultNative().keyRandom())).toBe(false)
  })

  it('any edited value fails the MAC', () => {
    const json = signPreunlock(content, k)
    const edits: Partial<PreunlockContent>[] = [
      { themeId: 'dark' },
      { motion: 'full' },
      { systemTitleBar: true },
      { idleMinutes: 0 },
      { lockOnSleep: false },
      { lockOnScreenLock: false },
      { quickUnlock: true },
    ]
    for (const e of edits) expect(verifyPreunlock({ ...json, ...e }, k), JSON.stringify(e)).toBe(false)
    expect(verifyPreunlock({ ...json, mac: 'x' }, k)).toBe(false)
    expect(verifyPreunlock({ ...json, extra: 1 }, k)).toBe(false)
    expect(verifyPreunlock('junk', k)).toBe(false)
  })

  it('is readable before unlock but schema-checked', () => {
    const json = signPreunlock(content, k)
    expect(parsePreunlock(json)).toEqual(content)
    expect(parsePreunlock({ ...json, idleMinutes: -1 })).toBeNull()
    expect(parsePreunlock({ ...json, motion: 'wild' })).toBeNull()
    expect(parsePreunlock({ ...json, themeId: 3 })).toBeNull()
  })

  it('writes and reads a file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'slate-pre-')), 'preunlock.json')
    expect(await readPreunlock(file)).toBeNull()
    await writePreunlock(file, content, k)
    const json = await readPreunlock(file)
    expect(verifyPreunlock(json, k)).toBe(true)
    expect(parsePreunlock(json)).toEqual(content)
  })
})
