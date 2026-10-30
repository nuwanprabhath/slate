import type { Session } from 'electron'
import type { Settings } from '../shared/api'
import { spellcheckAvailable } from '../shared/settings/spellcheck'

export { spellcheckAvailable }

type SpellSession = Pick<Session, 'setSpellCheckerEnabled' | 'setSpellCheckerLanguages' | 'setSpellCheckerDictionaryDownloadURL'>

/** Loopback's discard port: a dictionary request, if Chromium ever made one, never leaves the machine. */
const NO_DICTIONARY_SERVER = 'http://127.0.0.1:9/'

/**
 * Chromium's spell checker runs only while "Underline misspelled words" is on, and only where it is
 * the system's checker (`spellcheckAvailable`). Off, no field in any window is checked. Elsewhere it
 * stays off with no languages and no reachable dictionary server, so nothing is downloaded. It
 * only underlines; the editor turns off autocorrect, and no context menu offers its suggestions.
 */
export function applySpellcheck(session: SpellSession, settings: Pick<Settings, 'spellcheckUnderline'>, platform: string = process.platform): void {
  if (spellcheckAvailable(platform)) {
    session.setSpellCheckerEnabled(settings.spellcheckUnderline)
    return
  }
  session.setSpellCheckerEnabled(false)
  session.setSpellCheckerLanguages([])
  session.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_SERVER)
}
