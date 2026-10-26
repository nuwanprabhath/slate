import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nativeErrorCode } from '@slate/native'
import { dataKeyMatches, dbKeyMatches, importKey, kekMatches, liveHandles, masterKeyMatches, refSubkey, refSubkeyV2 } from '../../../test/vaultKeys'
import { KeyRing, Locked, deriveSubkey, type KeyName } from './keyring'
import { destroyKey, vaultNative } from './native'
import { SCHEDULE_V1, scheduleV2 } from './suite'

const INFO: Record<Exclude<KeyName, 'mk' | 'lk' | 'nameMac'>, string> = {
  sync: 'slate/v1/sync',
  name: 'slate/v1/name',
  nameEnc: 'slate/v1/name-enc',
  check: 'slate/v1/check',
  prefs: 'slate/v1/prefs',
  localwrap: 'slate/v1/local-wrap',
}

const ring = (mk: Uint8Array = randomBytes(32), lk: Uint8Array | null = randomBytes(32)) =>
  new KeyRing(importKey(mk, 'master'), lk ? importKey(lk, 'db') : undefined, SCHEDULE_V1)

// Appendix A: MK = 00 01 … 1f, vault id 00000000-0000-4000-8000-0000000000aa.
const KAT_MK = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const KAT_VAULT = '00000000-0000-4000-8000-0000000000aa'
const V2_LABEL: Record<Exclude<KeyName, 'mk' | 'lk'>, string> = {
  sync: 'slate/v2/sync',
  name: 'slate/v2/name',
  nameEnc: 'slate/v2/name-enc',
  nameMac: 'slate/v2/name-mac',
  check: 'slate/v2/check',
  prefs: 'slate/v2/prefs',
  localwrap: 'slate/v2/local-wrap',
}

describe('KeyRing, suite 0x02 (audit §4.5.2, listing B.13)', () => {
  it('Appendix A: K_sync, K_name_enc and K_name_mac are the SP 800-108r1 vectors', () => {
    const r = new KeyRing(importKey(KAT_MK, 'master'), undefined, scheduleV2(KAT_VAULT, 'standard'))
    expect(dataKeyMatches(r.get('sync'), Buffer.from('88ec1b4b04f78edf70ae4735963fa883f98c3bdfd18863c7cd6e8eb02b7b5388', 'hex'))).toBe(true)
    expect(dataKeyMatches(r.get('nameEnc'), Buffer.from('945f11ea9bf4b80dc2ca2f87255998fd341f56c6d9a6fb45a44aa067c1b3f589', 'hex'))).toBe(true)
    expect(dataKeyMatches(r.get('nameMac'), Buffer.from('5ed3ac7f8024fae8e05db04c670e85169ccb2a046814a7cd455d78575be4f36e', 'hex'))).toBe(true)
    r.close()
  })

  it('derives every subkey as KBKDF(MK, "slate/v2/" + x, vid), K_localwrap as a KEK, and holds nine handles', () => {
    const mk = randomBytes(32)
    const vaultId = '11111111-2222-4333-8444-555555555555'
    const r = new KeyRing(importKey(mk, 'master'), importKey(randomBytes(32), 'db'), scheduleV2(vaultId, 'fips-140-3'))
    for (const [name, label] of Object.entries(V2_LABEL)) {
      const matches = name === 'localwrap' ? kekMatches : dataKeyMatches
      expect(matches(r.get(name as KeyName), refSubkeyV2(mk, label, vaultId)), name).toBe(true)
    }
    expect(r.close()).toBe(9)
  })

  it('suite 0x01 has no name MAC key', () => {
    const r = ring()
    expect(() => r.get('nameMac')).toThrow(/No nameMac key/)
    expect(() => deriveSubkey(r.get('mk'), 'nameMac', SCHEDULE_V1)).toThrow(/no name MAC key/)
    r.close()
  })
})

describe('KeyRing', () => {
  it('hands out keys that cannot be turned into key text (red team re-run 5a; C4: a handle holds no bytes)', () => {
    const mk = randomBytes(32)
    const r = ring(mk)
    const key = r.get('mk')
    // A handle's text is a small number naming a slot in the module, never the key in hex or base64.
    for (const text of [String(key), JSON.stringify({ key })]) {
      expect(text).not.toContain(mk.toString('hex'))
      expect(text).not.toContain(mk.toString('base64'))
    }
    r.close()
  })

  it('hands out keys no copy or decoder turns into bytes (red team G2-5, G2-8)', () => {
    const r = ring()
    const mk = r.get('mk')
    // @ts-expect-error -- a KeyHandle is not bytes: Buffer.from cannot copy it
    expect(() => Buffer.from(mk)).toThrow()
    // @ts-expect-error -- nor is it a Uint8Array to pass where one is wanted
    const asBytes: Uint8Array = mk
    expect(asBytes instanceof Uint8Array).toBe(false)
    r.close()
  })

  it('lends no key bytes to any consumer: the bridges from C1/G2 are gone, a consumer passes the handle to the module', async () => {
    const exported = Object.keys(await import('./keyring'))
    for (const gone of ['withKeyBytes', 'zeroKey', 'vaultKeyBuffer', 'copyKey']) expect(exported, gone).not.toContain(gone)
    const r = ring()
    const sealed = vaultNative().gcmSeal(r.get('sync'), null, new Uint8Array(0), new Uint8Array(4))
    expect(sealed.length).toBe(12 + 4 + 16)
    r.close()
  })

  it('derives each subkey from MK with its spec info string', () => {
    const mk = randomBytes(32)
    const r = ring(mk)
    for (const [name, info] of Object.entries(INFO)) {
      const want = refSubkey(mk, info)
      // K_localwrap is a KEK (it wraps LK and nothing else); the others are data keys.
      const matches = name === 'localwrap' ? kekMatches : dataKeyMatches
      expect(matches(r.get(name as KeyName), want), name).toBe(true)
      const sub = deriveSubkey(r.get('mk'), name as keyof typeof INFO, SCHEDULE_V1)
      expect(matches(sub, want)).toBe(true)
      destroyKey(sub)
    }
    expect(masterKeyMatches(r.get('mk'), mk)).toBe(true)
    r.close()
  })

  it('hands out handles, never bytes, and owns them: the caller cannot keep a key past close', () => {
    const mk = randomBytes(32)
    const lk = randomBytes(32)
    const r = ring(mk, lk)
    const got = r.get('lk')
    expect(typeof got).toBe('number')
    expect(r.get('lk')).toBe(got)
    expect(dbKeyMatches(got, lk)).toBe(true)
    const sync = r.get('sync')
    r.close()
    // Unlike a copied Buffer, a handle kept by a caller names nothing after close: SCC_8, never zeros.
    let code: string | null = null
    try {
      vaultNative().gcmSeal(sync, null, new Uint8Array(0), new Uint8Array(1))
    } catch (e) {
      code = nativeErrorCode(e)
    }
    expect(code).toBe('SCC_8')
  })

  it('throws Locked from every accessor after close', () => {
    const r = ring()
    expect(r.isOpen).toBe(true)
    r.close()
    expect(r.isOpen).toBe(false)
    for (const name of ['mk', 'lk', ...Object.keys(INFO)] as KeyName[]) {
      expect(() => r.get(name)).toThrow(Locked)
    }
    expect(() => r.close()).not.toThrow()
  })

  it('throws when LK is missing', () => {
    const r = ring(randomBytes(32), null)
    expect(() => r.get('lk')).toThrow()
    r.close()
  })

  it('T-ZERO-01 (native): close destroys MK, LK and the six subkeys, and every handle then fails with SCC_8', () => {
    const before = liveHandles()
    const r = ring()
    const handles = (['mk', 'lk', ...Object.keys(INFO)] as KeyName[]).map((name) => r.get(name))
    expect(liveHandles()).toBe(before + 8)
    expect(r.close()).toBe(8)
    expect(liveHandles()).toBe(before)
    const zero = new Uint8Array(16)
    for (const h of handles) {
      let code: string | null = null
      try {
        vaultNative().aesEcbBlock(h, zero, true)
      } catch (e) {
        code = nativeErrorCode(e)
      }
      expect(code, String(h)).toBe('SCC_8')
    }
    expect(() => r.get('mk')).toThrow(Locked)
  })

  it('a ring whose subkeys cannot be derived destroys what it took (no handle left behind)', () => {
    const before = liveHandles()
    const mk = importKey(randomBytes(32), 'master')
    vaultNative().keyDestroy(mk)
    expect(() => new KeyRing(mk, importKey(randomBytes(32), 'db'), SCHEDULE_V1)).toThrow()
    expect(liveHandles()).toBe(before)
  })
})
