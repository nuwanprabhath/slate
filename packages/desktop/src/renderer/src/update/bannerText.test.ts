import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../../shared/api'
import { bannerText } from './bannerText'

const state = (over: Partial<UpdateState>): UpdateState => ({ phase: 'available', kind: 'deb', version: '0.6.0', currentVersion: '0.5.1', visible: true, ...over })

describe('bannerText', () => {
  it('offers the release and says what the person is on', () => {
    expect(bannerText(state({}))).toBe('Slate 0.6.0 is available · you are on 0.5.1')
  })

  it('says it is installing, with progress while the download is for Install and restart', () => {
    expect(bannerText(state({ phase: 'downloading', installRequested: true, progress: 40 }))).toBe('Installing Slate 0.6.0… 40%')
    expect(bannerText(state({ phase: 'downloading', progress: 40 }))).toBe('Slate 0.6.0 is available · downloading 40%')
    expect(bannerText(state({ phase: 'installing' }))).toBe('Installing Slate 0.6.0…')
    expect(bannerText(state({ phase: 'restarting' }))).toBe('Restarting into Slate 0.6.0…')
  })

  it('asks for the password, and says a refused one was refused', () => {
    expect(bannerText(state({ phase: 'needs-password' }))).toBe('Slate 0.6.0 needs your password to install')
    expect(bannerText(state({ phase: 'needs-password', installError: 'That password was not accepted.' }))).toBe('Could not install Slate 0.6.0: That password was not accepted.')
  })

  it('says why an install failed, wherever the state returns to', () => {
    for (const phase of ['downloaded', 'available'] as const) {
      expect(bannerText(state({ phase, installError: 'E: broken' }))).toBe('Could not install Slate 0.6.0: E: broken')
    }
  })

  it('keeps the old words for a plain download, with the drag hint for a dmg only', () => {
    expect(bannerText(state({ phase: 'downloaded', kind: 'dmg' }))).toBe('Slate 0.6.0 is downloaded · drag Slate into Applications')
    expect(bannerText(state({ phase: 'downloaded', kind: 'deb' }))).toBe('Slate 0.6.0 is downloaded')
  })
})
