// T-ZERO-04 / T-ZERO-07 (audit §6.3, C7): an encrypted data folder whose MK and LK this test process
// chose, so a memory scan knows what to look for. The app has no way to import a chosen key (the module
// makes every key itself; review C4 M1), so the canary enters the way a real vault does: this file writes
// vault.json and local-keys.json (format v1) with node:crypto and hash-wasm as the independent reference,
// and the app unwraps them (preunlock.json too, which the lock screen needs). Weak KDF parameters, which
// the app accepts only with SLATE_TEST_WEAK_KDF=1.
import { createCipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argon2id } from 'hash-wasm'
import { DEFAULT_SETTINGS } from '../src/shared/settings/schema'

/** 32 bytes each, with a recognisable prefix. */
export const CANARY = {
  mk: Buffer.from('c4a1a7d0' + '5a'.repeat(28), 'hex'),
  lk: Buffer.from('c4a1a7d1' + 'a5'.repeat(28), 'hex'),
} as const
export const CANARY_PASSWORD = 'canary-password-7f3e9b21c4'
export const CANARY_ENV = { SLATE_TEST_WEAK_KDF: '1' } as const

/** RFC 8785 for the header's values (integers and strings), as vault/header.ts `canonicalJson`. */
function canonicalJson(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const o = value as Record<string, unknown>
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
}

const subkey = (mk: Buffer, info: string): Buffer => Buffer.from(hkdfSync('sha256', mk, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32))

function seal(key: Buffer, plaintext: Buffer, aad: string): { nonce: string; ct: string } {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return { nonce: iv.toString('base64'), ct: ct.toString('base64') }
}

/** KEK_pw of `password` under `kdf`, recomputed independently of the app (hash-wasm). */
export async function passwordKek(password: string, kdf: { memoryKiB: number; passes: number; salt: string }): Promise<Buffer> {
  const out = await argon2id({
    password: Buffer.from(password.normalize('NFC'), 'utf8'),
    salt: Buffer.from(kdf.salt, 'base64'),
    iterations: kdf.passes,
    memorySize: kdf.memoryKiB,
    parallelism: 1,
    hashLength: 32,
    outputType: 'binary',
  })
  return Buffer.from(out)
}

/** Writes the canary vault into `userData`; returns KEK_pw, the third secret a scan looks for. */
export async function writeCanaryVault(userData: string): Promise<{ kek: Buffer }> {
  const vaultId = randomUUID()
  const deviceId = randomUUID()
  const kdf = { alg: 'argon2id', memoryKiB: 64, passes: 1, parallelism: 1, salt: randomBytes(16).toString('base64') }
  const kek = await passwordKek(CANARY_PASSWORD, kdf)
  const body = {
    format: 'slate-vault',
    version: 1,
    vaultId,
    revision: 1,
    createdAt: Date.now(),
    kdf,
    wraps: { password: seal(kek, CANARY.mk, `slate-vault/v1|${vaultId}|password|${canonicalJson(kdf)}`) },
  }
  const check = createHmac('sha256', subkey(CANARY.mk, 'slate/v1/check')).update(canonicalJson(body)).digest('base64')
  writeFileSync(join(userData, 'vault.json'), JSON.stringify({ ...body, check }))
  const lkWrap = seal(subkey(CANARY.mk, 'slate/v1/local-wrap'), CANARY.lk, `slate-lk/v1|${vaultId}|${deviceId}`)
  const db = `slate-${vaultId.slice(0, 8)}.db`
  writeFileSync(join(userData, 'local-keys.json'), JSON.stringify({ format: 'slate-local-keys', version: 1, vaultId, deviceId, db, ...lkWrap }))
  // The lock screen's own settings (§6.6), MACed under K_prefs as vault/preunlock.ts does.
  const s = DEFAULT_SETTINGS
  const prefs = { themeId: s.themeId, motion: s.motion, systemTitleBar: s.systemTitleBar, idleMinutes: s.idleMinutes, lockOnSleep: s.lockOnSleep, lockOnScreenLock: s.lockOnScreenLock, quickUnlock: s.quickUnlock }
  const mac = createHmac('sha256', subkey(CANARY.mk, 'slate/v1/prefs')).update(canonicalJson(prefs)).digest('base64')
  writeFileSync(join(userData, 'preunlock.json'), JSON.stringify({ ...prefs, mac }))
  return { kek }
}
