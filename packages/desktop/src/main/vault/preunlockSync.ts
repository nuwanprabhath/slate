import type { Settings } from '../../shared/api'
import type { KeyRing } from './keyring'
import { canonicalJson } from './header'
import { parsePreunlock, readPreunlock, verifyPreunlock, writePreunlock, type PreunlockContent } from './preunlock'
import type { ProfileId } from './profile'
import { SUITE } from './suite'

/** A header-v2 vault's preunlock.json is v2 and names its profile; a header-v1 vault keeps v1 (null). */
const fileProfile = (keyRing: KeyRing): ProfileId | null => (keyRing.schedule.suite === SUITE.KBKDF_AES256GCM ? keyRing.schedule.profile : null)

export function preunlockFromSettings(s: Settings): PreunlockContent {
  return {
    themeId: s.themeId,
    motion: s.motion,
    systemTitleBar: s.systemTitleBar,
    idleMinutes: s.idleMinutes,
    lockOnSleep: s.lockOnSleep,
    lockOnScreenLock: s.lockOnScreenLock,
    quickUnlock: s.quickUnlock,
  }
}

export async function savePreunlock(path: string, settings: Settings, keyRing: KeyRing): Promise<void> {
  await writePreunlock(path, preunlockFromSettings(settings), keyRing.get('prefs'), fileProfile(keyRing))
}

/** Before unlock: the values as they are, unverified. They only theme the lock screen and set its timers. */
export async function lockScreenPrefs(path: string): Promise<PreunlockContent | null> {
  return parsePreunlock(await readPreunlock(path))
}

/**
 * After unlock (§6.6): a file whose MAC fails was edited while locked, so it is rewritten from the
 * database, which holds the authoritative settings. A verified file that is merely stale (settings
 * that arrived by sync) is rewritten too, without the warning.
 */
export async function checkPreunlock(path: string, settings: Settings, keyRing: KeyRing): Promise<{ tampered: boolean }> {
  const json = await readPreunlock(path)
  const tampered = !verifyPreunlock(json, keyRing.get('prefs'), fileProfile(keyRing))
  const stale = tampered || canonicalJson(parsePreunlock(json)) !== canonicalJson(preunlockFromSettings(settings))
  if (stale) await savePreunlock(path, settings, keyRing)
  return { tampered }
}
