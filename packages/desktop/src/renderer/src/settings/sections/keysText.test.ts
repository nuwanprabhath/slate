import { describe, expect, it } from 'vitest'
import type { VaultKeysInfo } from '../../../../shared/api'
import { keysInfoText, rekeyIntro } from './keysText'

const info = (over: Partial<VaultKeysInfo> = {}): VaultKeysInfo => ({
  headerVersion: 2,
  profile: 'standard',
  keyEpoch: 0,
  createdAt: Date.UTC(2026, 0, 1),
  rotationDueSince: null,
  inProgress: null,
  blockingDevices: [],
  canRotate: true,
  canUpgrade: false,
  canConvert: true,
  canReplaceHistory: false,
  ...over,
})

describe('Settings → Security: the encryption keys (C9)', () => {
  it('states the format and the epoch, and nothing else when no change is pending', () => {
    const t = keysInfoText(info({ keyEpoch: 3 }))
    expect(t.testIds).toEqual(['security-keys-epoch'])
    expect(t.lines[0]).toMatch(/format version 2, key epoch 3/)
  })

  it('R-4: says when keys are due for rotation; D-7: names the devices to update first', () => {
    const t = keysInfoText(info({ profile: 'fips-140-3', rotationDueSince: Date.UTC(2028, 0, 1), blockingDevices: [{ name: 'Old laptop', appVersion: '0.1.4' }, { name: 'Phone' }] }))
    expect(t.testIds).toContain('security-rotation-due')
    expect(t.lines.join('\n')).toMatch(/Keys are due for rotation/)
    expect(t.lines.join('\n')).toMatch(/Old laptop \(0\.1\.4\), Phone \(version unknown\)/)
  })

  it('offers the v1 upgrade only once it can run, and reports a key change still syncing', () => {
    expect(keysInfoText(info({ headerVersion: 1, canUpgrade: true })).testIds).toContain('security-upgrade-offer')
    expect(keysInfoText(info({ headerVersion: 1, canUpgrade: false })).testIds).not.toContain('security-upgrade-offer')
    expect(keysInfoText(info({ inProgress: 'sweep' })).lines.join('\n')).toMatch(/Removing the files sealed under the old keys/)
  })

  it('the conversion says it cannot be undone and asks for a 15-character password; rotation keeps the password', () => {
    expect(rekeyIntro('convert')).toMatch(/cannot be undone/)
    expect(rekeyIntro('convert')).toMatch(/15 characters/)
    expect(rekeyIntro('rotate')).toMatch(/password stays the same/)
  })
})
