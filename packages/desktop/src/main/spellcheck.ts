import type { Session } from 'electron'
import type { Settings } from '../shared/api'

/**
 * Chromium's spell checker runs only while "Underline misspelled words" is on: off, no field in
 * any window is checked, and no dictionary is loaded. It only underlines; the editor turns off
 * autocorrect, and no context menu offers its suggestions.
 */
export function applySpellcheck(session: Pick<Session, 'setSpellCheckerEnabled'>, settings: Pick<Settings, 'spellcheckUnderline'>): void {
  session.setSpellCheckerEnabled(settings.spellcheckUnderline)
}
