import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, sanitizePatch } from './schema'

describe('settings schema', () => {
  it('fills every key from its default', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.autoBullets).toBe(true)
    expect(DEFAULT_SETTINGS.markdownShortcuts).toBe(false)
  })

  it('coerces bad stored values back to their defaults and drops unknown keys', () => {
    const merged = mergeSettings({ autoBullets: 'yes', markdownShortcuts: 1, syncProvider: 'dropbox', git: { remoteUrl: 3 }, deviceId: 7, junk: true })
    expect(merged).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps good stored values', () => {
    const git = { remoteUrl: 'git@github.com:me/n.git', branch: 'main', auth: 'gh' as const }
    expect(mergeSettings({ autoBullets: false, syncProvider: 'git', git, msClientId: 'abc' })).toMatchObject({ autoBullets: false, syncProvider: 'git', git, msClientId: 'abc' })
  })

  it('validates a patch, keeping only good keys', () => {
    expect(sanitizePatch({ autoBullets: false, markdownShortcuts: 'on', nope: 1 })).toEqual({ autoBullets: false })
    expect(sanitizePatch({ git: { remoteUrl: 'x', branch: 'main', auth: 'magic' } })).toEqual({})
    expect(sanitizePatch({ syncProvider: null })).toEqual({ syncProvider: null })
  })

  it('has the appearance settings: Dark, automatic animations, not following the system', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ themeId: 'builtin:dark', motion: 'auto', followSystem: false })
    expect(sanitizePatch({ themeId: 'user:abc', motion: 'reduced', followSystem: true })).toEqual({ themeId: 'user:abc', motion: 'reduced', followSystem: true })
    expect(sanitizePatch({ themeId: 'x'.repeat(200), motion: 'fast', followSystem: 'yes' })).toEqual({})
  })

  it('keeps font overrides per theme, dropping bad names and capping lengths', () => {
    expect(DEFAULT_SETTINGS.fontOverrides).toEqual({})
    const patch = sanitizePatch({
      fontOverrides: {
        'builtin:paper': { note: 'Georgia', ui: 'Inter' },
        'builtin:dark': { note: 'x;}body{color:red', ui: 'A'.repeat(200) },
        'builtin:nord': 'Georgia',
        ['k'.repeat(200)]: { note: 'Georgia' },
      },
    })
    expect(patch.fontOverrides).toEqual({ 'builtin:paper': { note: 'Georgia', ui: 'Inter' } })
    expect(sanitizePatch({ fontOverrides: ['Georgia'] }).fontOverrides).toBeUndefined()
    expect(sanitizePatch({ fontOverrides: null }).fontOverrides).toBeUndefined()
  })
})
