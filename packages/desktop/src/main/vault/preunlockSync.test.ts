import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHEDULE_V1 } from './suite'
import { importKey } from '../../../test/vaultKeys'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { KeyRing } from './keyring'
import { verifyPreunlock } from './preunlock'
import { checkPreunlock, lockScreenPrefs, preunlockFromSettings, savePreunlock } from './preunlockSync'

describe('preunlock.json upkeep (§6.6)', () => {
  const keyRing = new KeyRing(importKey(randomBytes(32), 'master'), importKey(randomBytes(32), 'db'), SCHEDULE_V1)
  const settings = { ...DEFAULT_SETTINGS, themeId: 'builtin:light', idleMinutes: 15 }

  it('takes the lock-screen fields from the settings, with a 30-minute idle default', () => {
    expect(DEFAULT_SETTINGS.idleMinutes).toBe(30)
    expect(preunlockFromSettings(settings)).toEqual({
      themeId: 'builtin:light',
      motion: 'auto',
      systemTitleBar: false,
      idleMinutes: 15,
      lockOnSleep: true,
      lockOnScreenLock: true,
      quickUnlock: false,
    })
  })

  it('accepts its own file after unlock', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'slate-pre-')), 'preunlock.json')
    await savePreunlock(path, settings, keyRing)
    expect(await checkPreunlock(path, settings, keyRing)).toEqual({ tampered: false })
    expect((await lockScreenPrefs(path))?.themeId).toBe('builtin:light')
  })

  it('rewrites a file edited while locked from the database settings, and reports it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'slate-pre-')), 'preunlock.json')
    await savePreunlock(path, settings, keyRing)
    const edited = { ...JSON.parse(readFileSync(path, 'utf8')), idleMinutes: 0 }
    writeFileSync(path, JSON.stringify(edited))
    // Unverified before unlock: the lock screen still reads it for its theme and timers.
    expect((await lockScreenPrefs(path))?.idleMinutes).toBe(0)
    expect(await checkPreunlock(path, settings, keyRing)).toEqual({ tampered: true })
    const back = JSON.parse(readFileSync(path, 'utf8'))
    expect(back.idleMinutes).toBe(15)
    expect(verifyPreunlock(back, keyRing.get('prefs'))).toBe(true)
  })

  it('treats a missing file as tampered and writes it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'slate-pre-')), 'preunlock.json')
    expect(await lockScreenPrefs(path)).toBeNull()
    expect(await checkPreunlock(path, settings, keyRing)).toEqual({ tampered: true })
    expect(verifyPreunlock(JSON.parse(readFileSync(path, 'utf8')), keyRing.get('prefs'))).toBe(true)
  })
})
