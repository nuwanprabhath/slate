import { describe, expect, it } from 'vitest'
import { applySpellcheck, spellcheckAvailable } from './spellcheck'

function fakeSession() {
  const calls: string[] = []
  return {
    calls,
    setSpellCheckerEnabled: (on: boolean) => void calls.push(`enabled ${String(on)}`),
    setSpellCheckerLanguages: (languages: string[]) => void calls.push(`languages ${JSON.stringify(languages)}`),
    setSpellCheckerDictionaryDownloadURL: (url: string) => void calls.push(`download ${url}`),
  }
}

describe('spellcheckAvailable', () => {
  it('is only where the system checker needs no download: macOS and Windows, not Linux', () => {
    expect(spellcheckAvailable('darwin')).toBe(true)
    expect(spellcheckAvailable('win32')).toBe(true)
    expect(spellcheckAvailable('linux')).toBe(false)
    expect(spellcheckAvailable('freebsd')).toBe(false)
  })
})

describe('applySpellcheck', () => {
  it("on macOS runs the session's checker only while misspelled words are to be underlined", () => {
    const session = fakeSession()
    applySpellcheck(session, { spellcheckUnderline: false }, 'darwin')
    applySpellcheck(session, { spellcheckUnderline: true }, 'darwin')
    expect(session.calls).toEqual(['enabled false', 'enabled true'])
  })

  it('on Windows follows the setting, but never has a reachable dictionary server, and no languages while off', () => {
    const off = fakeSession()
    applySpellcheck(off, { spellcheckUnderline: false }, 'win32')
    expect(off.calls).toContain('enabled false')
    expect(off.calls).toContain('languages []')
    const on = fakeSession()
    applySpellcheck(on, { spellcheckUnderline: true }, 'win32')
    expect(on.calls).toContain('enabled true')
    for (const s of [off, on]) {
      const download = s.calls.find((c) => c.startsWith('download '))
      expect(download).toBeDefined()
      expect(new URL(download!.slice('download '.length)).hostname).toBe('127.0.0.1')
    }
  })

  it('on Linux never turns the checker on, and leaves it nothing to download from anywhere', () => {
    const session = fakeSession()
    applySpellcheck(session, { spellcheckUnderline: true }, 'linux')
    expect(session.calls).not.toContain('enabled true')
    expect(session.calls).toContain('enabled false')
    expect(session.calls).toContain('languages []')
    const download = session.calls.find((c) => c.startsWith('download '))
    expect(download).toBeDefined()
    expect(new URL(download!.slice('download '.length)).hostname).toBe('127.0.0.1')
  })
})
