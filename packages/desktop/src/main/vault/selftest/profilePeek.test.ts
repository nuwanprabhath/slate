// S-4: the start requires the FIPS provider when the install policy, the vault header's profile or the profile
// floor says fips-140-3; each read is unverified and null on any error.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { headerProfilePeek, policyRequiresFips, profileFloor, startRequiresFips } from './profilePeek'

const dir = () => mkdtempSync(join(tmpdir(), 'slate-peek-'))
const VAULT_ID = '00000000-0000-4000-8000-0000000000aa'
const floorFile = (profile: string) => JSON.stringify({ format: 'slate-profile-floor', version: 1, vaultId: VAULT_ID, profile, minHeaderVersion: 2, mac: `${'A'.repeat(43)}=` })

describe('S-4: does this start require the FIPS provider?', () => {
  it('reads nothing into a missing, unreadable or malformed file', async () => {
    const d = dir()
    expect(await policyRequiresFips(d)).toBeNull()
    expect(await headerProfilePeek(d)).toBeNull()
    expect(await profileFloor(d)).toBeNull()
    expect(await startRequiresFips(d, d)).toBe(false)
    writeFileSync(join(d, 'vault.json'), '{not json')
    writeFileSync(join(d, 'policy.json'), '[true]')
    mkdirSync(join(d, 'profile-floor.json'))
    expect(await headerProfilePeek(d)).toBeNull()
    expect(await policyRequiresFips(d)).toBeNull()
    expect(await profileFloor(d)).toBeNull()
    writeFileSync(join(d, 'vault.json'), JSON.stringify({ profile: 'fips-140-2' }))
    expect(await headerProfilePeek(d)).toBeNull()
  })

  it('(a) a managed install policy', async () => {
    const d = dir()
    writeFileSync(join(d, 'policy.json'), JSON.stringify({ requireFips: true }))
    expect(await policyRequiresFips(d)).toBe(true)
    expect(await startRequiresFips(d, dir())).toBe(true)
    writeFileSync(join(d, 'policy.json'), JSON.stringify({ requireFips: 'yes' }))
    expect(await startRequiresFips(d, dir())).toBe(false)
  })

  it('(b) the vault header names fips-140-3', async () => {
    const d = dir()
    writeFileSync(join(d, 'vault.json'), JSON.stringify({ version: 2, profile: 'standard' }))
    expect(await startRequiresFips(dir(), d)).toBe(false)
    writeFileSync(join(d, 'vault.json'), JSON.stringify({ version: 2, profile: 'fips-140-3' }))
    expect(await headerProfilePeek(d)).toBe('fips-140-3')
    expect(await startRequiresFips(dir(), d)).toBe(true)
  })

  it('(c) the profile floor (or local-keys.json v2) says fips-140-3, even when vault.json is gone', async () => {
    const d = dir()
    writeFileSync(join(d, 'profile-floor.json'), floorFile('fips-140-3'))
    expect(await profileFloor(d)).toBe('fips-140-3')
    expect(await startRequiresFips(dir(), d)).toBe(true)
    const e = dir()
    writeFileSync(join(e, 'profile-floor.json'), floorFile('standard'))
    writeFileSync(join(e, 'local-keys.json'), JSON.stringify({ version: 2, vaultId: VAULT_ID, profile: 'fips-140-3' }))
    expect(await profileFloor(e)).toBe('fips-140-3')
  })
})
