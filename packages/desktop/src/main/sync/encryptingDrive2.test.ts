// EncryptingDrive for a header-v2 vault (suite 0x02, audit §4.6): 64-hex SIV names, SLE2 with padded
// document records, and a fips-140-3 vault that never reads suite 0x01 (T-POL-07).
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine, type RemoteDrive } from '@slate/sync'
import { memoryDrive, type MemoryDrive } from '../../../../sync/test/memoryDrive'
import { addTextBox, boxText, editPage, memoryLocal } from '../../../../sync/test/memoryLocal'
import { importKey } from '../../../test/vaultKeys'
import { parseEnvelope, sealEnvelope } from '../vault/envelope'
import { KeyRing } from '../vault/keyring'
import { encodeIdV2 } from '../vault/names'
import { PROFILES, type ProfileId } from '../vault/profile'
import { SCHEDULE_V1, scheduleV2, SUITE } from '../vault/suite'
import { EncryptingDrive } from './encryptingDrive'

const NOTICE = /^\d+ synced files could not be verified and were ignored$/
const VAULT = '7f8e9d0c-1b2a-4c3d-8e4f-5a6b7c8d9e0f'
const rings: KeyRing[] = []
afterEach(() => {
  for (const ring of rings.splice(0)) ring.close()
})

function ring(mk: Buffer, profile: ProfileId = 'standard'): KeyRing {
  const r = new KeyRing(importKey(mk, 'master'), undefined, scheduleV2(VAULT, profile))
  rings.push(r)
  return r
}

function device(inner: RemoteDrive, keys: KeyRing) {
  const local = memoryLocal()
  const remote = new EncryptingDrive(inner, keys)
  const deviceId = randomUUID()
  return { local, keys, remote, deviceId, engine: new SyncEngine({ local, remote, deviceId, deviceName: 'test' }) }
}

const files = (inner: MemoryDrive) => [...inner.files.keys()]
const names = (keys: KeyRing) => ({ enc: keys.get('nameEnc'), mac: keys.get('nameMac') })

describe('EncryptingDrive, suite 0x02', () => {
  it('maps engine paths to 64-hex SIV names (audit §4.6 remote layout), seals SLE2, and pads document records', async () => {
    const inner = memoryDrive()
    const keys = ring(randomBytes(32))
    const drive = new EncryptingDrive(inner, keys)
    const doc = randomUUID()
    const dev = randomUUID()
    await drive.upload(`docs/page_${doc}/${dev}/00000003.chunk`, new Uint8Array([1]))
    await drive.upload(`devices/${dev}.json`, new Uint8Array([3]))
    const p = encodeIdV2(names(keys), 'page', doc)
    const v = encodeIdV2(names(keys), 'device', dev)
    expect(p).toMatch(/^[0-9a-f]{64}$/)
    expect(files(inner)).toEqual([`e2ee/d/${p}/${v}/00000003.c`, `e2ee/v/${v}.c`])
    for (const bytes of inner.files.values()) expect(parseEnvelope(bytes)).toMatchObject({ format: 'SLE2', suite: 2, keyEpoch: 0, flags: 0x03 })
    expect((await drive.delta(null)).items.map((i) => i.path)).toEqual([`docs/page_${doc}/${dev}/00000003.chunk`, `devices/${dev}.json`])
    expect(await drive.download(`devices/${dev}.json`)).toEqual(new Uint8Array([3]))
  })

  it('blobs are SLE2 without padding, under their one-way names', async () => {
    const inner = memoryDrive()
    const drive = new EncryptingDrive(inner, ring(randomBytes(32)))
    const bytes = randomBytes(100)
    const { createHash } = await import('node:crypto')
    const name = `${createHash('sha256').update(bytes).digest('hex')}.png`
    await drive.upload(`blobs/${name}`, bytes)
    const [remote] = files(inner)
    expect(remote).toMatch(/^e2ee\/b\/[0-9a-f]{64}$/)
    expect(parseEnvelope(inner.files.get(remote!)!).flags).toBe(0)
    expect(Buffer.from(await drive.download(`blobs/${name}`))).toEqual(bytes)
  })

  it('syncs a page between two devices of one vault, and a forged 64-hex name fails the SIV and is never listed', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, ring(mk))
    const b = device(inner, ring(mk))
    const page = `page:${randomUUID()}`
    const x = editPage(a.local, page, (p) => addTextBox(p, 'v2 marker'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    const [one] = files(inner).filter((n) => n.startsWith('e2ee/d/'))
    // A name with one bit changed is well-formed but not ours: delta drops it, nothing is downloaded.
    const flipped = one!.replace(/^e2ee\/d\/([0-9a-f])/, (_m, c: string) => `e2ee/d/${((parseInt(c, 16) ^ 1) & 15).toString(16)}`)
    await inner.upload(flipped, inner.files.get(one!)!)
    expect((await b.remote.delta(null)).items.filter((i) => i.path.startsWith('docs/'))).toHaveLength(1)
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect(boxText(new PageDoc(b.local.doc(page)), x)).toBe('v2 marker')
    expect(b.local.notes).toEqual([])
  })

  it('a suite-0x01 (32-hex) name is not a v2 vault’s, and a v1 vault does not read 64-hex names', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const v2 = new EncryptingDrive(inner, ring(mk))
    const v1Ring = new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1)
    rings.push(v1Ring)
    const v1 = new EncryptingDrive(inner, v1Ring)
    const dev = randomUUID()
    await v1.upload(`devices/${dev}.json`, new Uint8Array([1]))
    await v2.upload(`devices/${randomUUID()}.json`, new Uint8Array([2]))
    expect((await v2.delta(null)).items).toHaveLength(1)
    expect((await v1.delta(null)).items).toHaveLength(1)
  })

  it('T-POL-07: a fips-140-3 vault skips a suite 0x01 file under its own name as unverifiable', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, ring(mk, 'fips-140-3'))
    const b = device(inner, ring(mk, 'fips-140-3'))
    const page = `page:${randomUUID()}`
    editPage(a.local, page, (p) => addTextBox(p, 'one'))
    await a.engine.syncOnce()
    const [one] = files(inner).filter((n) => n.startsWith('e2ee/d/'))
    const enginePath = (await a.remote.delta(null)).items.find((i) => i.path.startsWith('docs/'))!.path
    // The same plaintext path sealed as SLE1 (suite 0x01) under the vault's own K_sync: refused by readSuites.
    const sle1 = sealEnvelope({ syncKey: a.keys.get('sync'), suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites }, enginePath, new Uint8Array([1]))
    inner.files.set(one!, sle1)
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 0 })
    expect(b.local.notes).toEqual([expect.stringMatching(NOTICE)])
  })
})
