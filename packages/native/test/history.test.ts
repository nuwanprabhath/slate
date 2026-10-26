// C9: key-epoch history in the shipped addon (audit §4.5.2 K_hist, §4.7 R-1), checked against node:crypto as the
// independent reference: K_hist,e = KBKDF(MK_current, "slate/v2/history", vid || uint32be(e)) wraps MK_e.
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KeyHandle, SlateNative } from '../index'

const addon = join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node')
const n = createRequire(import.meta.url)(addon) as SlateNative
try {
  n.init('', '', false)
} catch {
  // Already initialised by another test file in this process.
}

const code = (fn: () => unknown): string | null => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
  return null
}

const VID = Buffer.from('000000000000400080000000000000aa', 'hex')
const ctxOf = (epoch: number) => Buffer.concat([VID, Buffer.from([(epoch >>> 24) & 255, (epoch >>> 16) & 255, (epoch >>> 8) & 255, epoch & 255])])

function refKbkdf(key: Uint8Array, label: string, context: Uint8Array): Buffer {
  return createHmac('sha256', key).update(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(label), Buffer.from([0]), context, Buffer.from([0, 0, 1, 0])])).digest()
}

/** Known bytes as a master key wrapped under a PBKDF2 KEK: returns the proof (KEK and wrap) and the opened handle. */
function proofOf(bytes: Uint8Array): { kek: KeyHandle; iv: Buffer; aad: Buffer; ct: Buffer; mk: KeyHandle } {
  const password = randomBytes(16)
  const salt = randomBytes(16)
  const aad = Buffer.from('slate/test/proof')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', pbkdf2Sync(password, salt, 1000, 32, 'sha512'), iv).setAAD(aad)
  const ct = Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()])
  const kek = n.pbkdf2(new Uint8Array(password), salt, 1000)
  return { kek, iv, aad, ct, mk: n.gcmOpenKey(kek, iv, aad, ct, 'master') }
}

/** A key's identity without its bytes: HMAC under its KBKDF sync subkey, compared with the reference. */
function probe(mk: KeyHandle): string {
  const k = n.kbkdf(mk, 'slate/v2/sync', VID)
  try {
    return Buffer.from(n.hmacSha256(k, Buffer.from('probe'))).toString('hex')
  } finally {
    n.keyDestroy(k)
  }
}
const refProbe = (bytes: Uint8Array) => createHmac('sha256', refKbkdf(bytes, 'slate/v2/sync', VID)).update('probe').digest('hex')

describe('C9 history in the shipped addon', () => {
  it('historySeal output opens under the reference K_hist, and historyOpen opens a reference entry', () => {
    const oldBytes = randomBytes(32)
    const curBytes = randomBytes(32)
    const old = proofOf(oldBytes)
    const cur = proofOf(curBytes)
    const aad = Buffer.from('slate-vault/v2|history|3')
    const entry = n.historySeal(old.kek, old.iv, old.aad, old.ct, cur.mk, ctxOf(3), aad)
    expect(entry.length).toBe(60)
    const d = createDecipheriv('aes-256-gcm', refKbkdf(curBytes, 'slate/v2/history', ctxOf(3)), entry.subarray(0, 12)).setAAD(aad)
    d.setAuthTag(entry.subarray(44))
    expect(Buffer.concat([d.update(entry.subarray(12, 44)), d.final()]).equals(oldBytes)).toBe(true)
    // The other direction: an entry made by the reference opens to a master key equal to its bytes.
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', refKbkdf(curBytes, 'slate/v2/history', ctxOf(9)), iv).setAAD(aad)
    const ct = Buffer.concat([c.update(oldBytes), c.final(), c.getAuthTag()])
    const opened = n.historyOpen(cur.mk, ctxOf(9), iv, aad, ct)
    expect(probe(opened)).toBe(refProbe(oldBytes))
    expect(code(() => n.historyOpen(cur.mk, ctxOf(8), iv, aad, ct))).toBe('SCC_11')
    // An opened history key is never wrapped again: no fresh-key wrap, so no export.
    expect(code(() => n.gcmSealKey(old.kek, opened, null, aad))).toBe('SCC_17')
    for (const k of [old.kek, old.mk, cur.kek, cur.mk, opened]) n.keyDestroy(k)
  })

  it('review C9 M1: no public KDF derives K_hist, or a data key under a local-wrap label', () => {
    const cur = proofOf(randomBytes(32))
    expect(code(() => n.kbkdf(cur.mk, 'slate/v2/history', ctxOf(0)))).toBe('SCC_17')
    expect(code(() => n.kbkdf(cur.mk, 'slate/v2/history', ctxOf(0), 'kek'))).toBe('SCC_17')
    expect(code(() => n.kbkdfFromSecret(randomBytes(32), 'slate/v2/history', ctxOf(0), false))).toBe('SCC_17')
    expect(code(() => n.kbkdf(cur.mk, 'slate/v2/local-wrap', VID))).toBe('SCC_17')
    // The local-wrap KEK itself is still derivable: it wraps database keys inside the module and opens none to JS.
    n.keyDestroy(n.kbkdf(cur.mk, 'slate/v2/local-wrap', VID, 'kek'))
    for (const k of [cur.kek, cur.mk]) n.keyDestroy(k)
  })

  it('historyRewrap moves an entry to the next epoch only for the holder of the current key\'s proof', () => {
    const oldBytes = randomBytes(32)
    const old = proofOf(oldBytes)
    const cur = proofOf(randomBytes(32))
    const next = proofOf(randomBytes(32))
    const aad = Buffer.from('a')
    const entry = n.historySeal(old.kek, old.iv, old.aad, old.ct, cur.mk, ctxOf(0), aad)
    const moved = n.historyRewrap(cur.kek, cur.iv, cur.aad, cur.ct, ctxOf(0), entry.subarray(0, 12), aad, entry.subarray(12), next.mk, ctxOf(0), aad)
    expect(probe(n.historyOpen(next.mk, ctxOf(0), moved.subarray(0, 12), aad, moved.subarray(12)))).toBe(refProbe(oldBytes))
    // The old key's proof does not open the entry's K_hist: refused.
    expect(code(() => n.historyRewrap(old.kek, old.iv, old.aad, old.ct, ctxOf(0), entry.subarray(0, 12), aad, entry.subarray(12), next.mk, ctxOf(0), aad))).toBe('SCC_11')
    // A data key is never the epoch's key, and the proof must be a password-class KEK.
    const data = n.keyRandom('data')
    expect(code(() => n.historySeal(old.kek, old.iv, old.aad, old.ct, data, ctxOf(0), aad))).toBe('SCC_17')
    expect(code(() => n.historySeal(data, old.iv, old.aad, old.ct, cur.mk, ctxOf(0), aad))).toBe('SCC_17')
    expect(code(() => n.historySeal(old.kek, old.iv, old.aad, old.ct, old.mk, ctxOf(0), aad))).toBe('SCC_1')
    expect(code(() => n.historyOpen(cur.mk, VID, entry.subarray(0, 12), aad, entry.subarray(12)))).toBe('SCC_1')
    for (const k of [old.kek, old.mk, cur.kek, cur.mk, next.kek, next.mk, data]) n.keyDestroy(k)
  })
})
