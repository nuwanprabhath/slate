/**
 * Where "Underline misspelled words" can be offered: macOS and Windows use the system's own spell
 * checker. Elsewhere (Linux) Chromium would download Hunspell dictionaries from Google, and Slate
 * contacts no server for this.
 */
export function spellcheckAvailable(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export const SPELLCHECK_UNAVAILABLE_HELP = 'Not available on Linux: it would download dictionaries from the internet.'
