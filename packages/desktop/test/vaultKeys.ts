// Test support for the main-process vault tests (audit C4, review C4 M1). The module exports no key, and
// imports one only the way the vault formats themselves do: a master key unwrapped under a password-class
// KEK, a database key unwrapped under a master key's local-wrap KEK. So known keys enter through those
// paths, and a handle is compared with known bytes by what it does (it seals what the bytes open), never by
// reading it. node:crypto here is the independent reference; only tests import this file.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argon2id } from 'hash-wasm'
import { nativeErrorCode, type KeyHandle } from '@slate/native'
import { openDatabase, WrongKey } from '../src/main/db/openDatabase'
import { vaultNative } from '../src/main/vault/native'

const TRANSPORT = 'slate/test/key-transport'
const PROBE = 'slate/test/probe'
const AAD = new TextEncoder().encode(TRANSPORT)
const EMPTY = new Uint8Array(0)

/** RFC 5869 HKDF-SHA-256, 32 bytes: the audited `hkdf` of vault/crypto.ts. */
export function refHkdf(key: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(info, 'utf8'), 32))
}

/** A suite-0x01 subkey of a known MK (keyring.ts INFO), computed outside the module. */
export function refSubkey(mk: Uint8Array, info: string): Buffer {
  return refHkdf(mk, EMPTY, info)
}

/** SP 800-108r1 counter mode, HMAC-SHA-256, one block: [1]32 || Label || 0x00 || Context || [256]32 (suite 0x02). */
export function refKbkdf(key: Uint8Array, label: string, context: Uint8Array): Buffer {
  return createHmac('sha256', key).update(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(label), Buffer.from([0]), context, Buffer.from([0, 0, 1, 0])])).digest()
}

/** `vid`: a vault id's 16 bytes, the KBKDF Context of suite-0x02 subkeys. */
export const refVid = (vaultId: string): Buffer => Buffer.from(vaultId.replace(/-/g, ''), 'hex')

/** A suite-0x02 subkey of a known MK (keyring.ts V2_LABEL), computed outside the module. */
export function refSubkeyV2(mk: Uint8Array, label: string, vaultId: string): Buffer {
  return refKbkdf(mk, label, refVid(vaultId))
}

function sealWith(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = AAD): { iv: Buffer; ct: Buffer } {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(aad)
  return { iv, ct: Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]) }
}

function openWith(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, aad: Uint8Array = AAD): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv).setAAD(aad)
    d.setAuthTag(ct.subarray(ct.length - 16))
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  } catch {
    return null
  }
}

/** Known bytes as a master key: wrapped here under a password-class KEK whose bytes this file derives too. */
function importMaster(bytes: Uint8Array): KeyHandle {
  const n = vaultNative()
  const secret = randomBytes(32)
  const { iv, ct } = sealWith(refHkdf(secret, EMPTY, TRANSPORT), bytes)
  const kek = n.hkdfFromSecret(new Uint8Array(secret), EMPTY, TRANSPORT)
  try {
    return n.gcmOpenKey(kek, iv, AAD, ct, 'master')
  } finally {
    n.keyDestroy(kek)
  }
}

/** Known bytes as a database key: wrapped under the local-wrap KEK of a master key this file knows. */
function importDb(bytes: Uint8Array): KeyHandle {
  const n = vaultNative()
  const mkBytes = randomBytes(32)
  const mk = importMaster(mkBytes)
  const kek = n.hkdfLegacy(mk, EMPTY, 'slate/v1/local-wrap', 'kek')
  try {
    const { iv, ct } = sealWith(refSubkey(mkBytes, 'slate/v1/local-wrap'), bytes)
    return n.gcmOpenKey(kek, iv, AAD, ct, 'db')
  } finally {
    n.keyDestroy(kek)
    n.keyDestroy(mk)
  }
}

/** Known bytes as a module key of `usage` (master or db: the formats' own ways in). The caller owns the handle. */
export function importKey(bytes: Uint8Array, usage: 'master' | 'db'): KeyHandle {
  return usage === 'master' ? importMaster(bytes) : importDb(bytes)
}

/** A data key and its bytes: a subkey of a known master key, as the KeyRing derives them. The caller owns the handle. */
export function knownDataKey(info = 'slate/test/data'): { key: KeyHandle; bytes: Buffer } {
  const mkBytes = randomBytes(32)
  const mk = importMaster(mkBytes)
  try {
    return { key: vaultNative().hkdfLegacy(mk, EMPTY, info), bytes: refSubkey(mkBytes, info) }
  } finally {
    vaultNative().keyDestroy(mk)
  }
}

/** Whether a data key holds `bytes`: what it seals, the bytes open. */
export function dataKeyMatches(key: KeyHandle, bytes: Uint8Array): boolean {
  const probe = randomBytes(16)
  const sealed = vaultNative().gcmSeal(key, null, AAD, probe)
  return openWith(bytes, sealed.subarray(0, 12), sealed.subarray(12))?.equals(probe) ?? false
}

/** Whether a master key holds `bytes`: a derived probe subkey matches the reference derivation. */
export function masterKeyMatches(mk: KeyHandle, bytes: Uint8Array): boolean {
  const sub = vaultNative().hkdfLegacy(mk, EMPTY, PROBE)
  try {
    return dataKeyMatches(sub, refSubkey(bytes, PROBE))
  } finally {
    vaultNative().keyDestroy(sub)
  }
}

/** Whether a KEK holds `bytes`: it wraps a fresh database key that the bytes unwrap. */
export function kekMatches(kek: KeyHandle, bytes: Uint8Array): boolean {
  const n = vaultNative()
  const db = n.keyRandom('db')
  try {
    const w = n.gcmSealKey(kek, db, null, AAD)
    return openWith(bytes, w.subarray(0, 12), w.subarray(12)) !== null
  } finally {
    n.keyDestroy(db)
  }
}

/** Whether two database keys are one key: a database keyed with `a` opens with `b`. */
export function sameDbKey(a: KeyHandle, b: KeyHandle): boolean {
  const file = join(mkdtempSync(join(tmpdir(), 'slate-dbkey-')), 'probe.db')
  const db = openDatabase(file, a)
  db.exec('CREATE TABLE probe (v INTEGER)')
  db.close()
  try {
    openDatabase(file, b).close()
    return true
  } catch (e) {
    if (e instanceof WrongKey) return false
    throw e
  }
}

/** Whether a database key holds `bytes`. */
export function dbKeyMatches(key: KeyHandle, bytes: Uint8Array): boolean {
  const known = importDb(bytes)
  try {
    return sameDbKey(key, known)
  } finally {
    vaultNative().keyDestroy(known)
  }
}

/** Whether two master keys are one key. */
export function sameMaster(a: KeyHandle, b: KeyHandle): boolean {
  const n = vaultNative()
  const [x, y] = [n.hkdfLegacy(a, EMPTY, PROBE), n.hkdfLegacy(b, EMPTY, PROBE)]
  try {
    const sealed = n.gcmSeal(x, null, AAD, new Uint8Array(16))
    n.gcmOpen(y, sealed.subarray(0, 12), AAD, sealed.subarray(12))
    return true
  } catch (e) {
    if (nativeErrorCode(e) === 'SCC_11') return false
    throw e
  } finally {
    n.keyDestroy(x)
    n.keyDestroy(y)
  }
}

/**
 * Whether a password-class KEK holds `bytes`. Such a key never leaves the module, even to a test, so this
 * wraps a fresh master key under it and opens the wrap with `bytes` in node:crypto.
 */
export function passwordKeyMatches(kek: KeyHandle, bytes: Uint8Array): boolean {
  const n = vaultNative()
  const mk = n.keyRandom('master')
  try {
    const sealed = n.gcmSealKey(kek, mk, null, AAD)
    return openWith(bytes, sealed.subarray(0, 12), sealed.subarray(12)) !== null
  } finally {
    n.keyDestroy(mk)
  }
}

/** Whether two password-class KEKs hold the same key: what one wraps, the other unwraps. */
export function samePasswordKey(a: KeyHandle, b: KeyHandle): boolean {
  const n = vaultNative()
  const mk = n.keyRandom('master')
  try {
    const sealed = n.gcmSealKey(a, mk, null, AAD)
    try {
      n.keyDestroy(n.gcmOpenKey(b, sealed.subarray(0, 12), AAD, sealed.subarray(12)))
      return true
    } catch (e) {
      if (nativeErrorCode(e) === 'SCC_11') return false
      throw e
    }
  } finally {
    n.keyDestroy(mk)
  }
}

/** Whether the module still holds the key a handle names: SCC_8 once destroyed, never zeros. */
export function isLive(key: KeyHandle): boolean {
  try {
    vaultNative().hmacSha256(key, new Uint8Array(16))
    return true
  } catch (e) {
    const code = nativeErrorCode(e)
    if (code === 'SCC_8') return false
    // A key HMAC may not use (a master, database or password-class key): live all the same.
    if (code === 'SCC_17') return true
    throw e
  }
}

/**
 * A test vault's MK, recomputed outside the module from the password (hash-wasm for Argon2id, node:crypto
 * for the unwrap): the reference for checks that a handle holds the vault's master key.
 */
const canonical = (o: Record<string, unknown>): string => '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(',') + '}'

/**
 * A test vault's MK, recomputed outside the module from the password (hash-wasm for Argon2id, node:crypto
 * for PBKDF2 and the unwrap), for header v1 and v2: the reference for checks that a handle holds the vault's MK.
 */
export async function mkBytesOf(dataDir: string, password: string): Promise<Buffer> {
  const header = JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as {
    version: 1 | 2
    vaultId: string
    profile?: string
    keyEpoch?: number
    kdf: Record<string, unknown> & { alg: string; memoryKiB: number; passes: number; iterations: number; salt: string }
    wraps: { password: { nonce: string; ct: string } }
  }
  const kdf = header.kdf
  const salt = Buffer.from(kdf.salt, 'base64')
  const kek =
    kdf.alg === 'pbkdf2-hmac-sha512'
      ? pbkdf2Sync(Buffer.from(password.normalize('NFC')), salt, kdf.iterations, 32, 'sha512')
      : await argon2id({ password: password.normalize('NFC'), salt, iterations: kdf.passes, memorySize: kdf.memoryKiB, parallelism: 1, hashLength: 32, outputType: 'binary' })
  const wrapAad =
    header.version === 2
      ? Buffer.from(`slate-vault/v2|${header.vaultId}|password|${header.profile!}|2|${header.keyEpoch!}|${canonical(kdf)}`)
      : Buffer.from(`slate-vault/v1|${header.vaultId}|password|${canonical(kdf)}`)
  const mk = openWith(kek, Buffer.from(header.wraps.password.nonce, 'base64'), Buffer.from(header.wraps.password.ct, 'base64'), wrapAad)
  if (!mk) throw new Error('mkBytesOf: the password does not open this vault')
  return mk
}

/** A test vault's LK bytes, recomputed outside the module from the password: for "no copy of LK anywhere" checks. */
export async function lkBytesOf(dataDir: string, password: string): Promise<Buffer> {
  const mk = await mkBytesOf(dataDir, password)
  const lk = JSON.parse(readFileSync(join(dataDir, 'local-keys.json'), 'utf8')) as Record<string, unknown> & { version: 1 | 2; vaultId: string; deviceId: string; nonce: string; ct: string }
  const { nonce, ct, ...bound } = lk
  const [kWrap, lkAad] =
    lk.version === 2
      ? [refSubkeyV2(mk, 'slate/v2/local-wrap', lk.vaultId), Buffer.from(`slate-lk/v2|${canonical(bound)}`)]
      : [refSubkey(mk, 'slate/v1/local-wrap'), Buffer.from(`slate-lk/v1|${lk.vaultId}|${lk.deviceId}`)]
  const bytes = openWith(kWrap, Buffer.from(nonce, 'base64'), Buffer.from(ct, 'base64'), lkAad)
  if (!bytes) throw new Error('lkBytesOf: local-keys.json does not open')
  return bytes
}

/** Live handles in the module, for "nothing was left behind" checks. */
export const liveHandles = (): number => vaultNative().status().liveHandles
