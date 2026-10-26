// KEK_pw: the password KDF a profile selects (audit §4.1). The standard profile uses Argon2id (BSI
// TR-02102-1), the fips-140-3 profile PBKDF2-HMAC-SHA-512 (SP 800-132). Both run in @slate/native; this is
// the only file that calls the module's Argon2id (lint rule `slate/legacy-crypto-in-v1-path`).
import type { KeyHandle } from '@slate/native'
import { destroyKey, toBase64, utf8, vaultNative } from './native'
import type { ProfileId } from './profile'
import { moduleCopy, type SecretBytes } from '../../shared/secret'

export interface Argon2idParams {
  alg: 'argon2id'
  memoryKiB: number
  passes: number
  parallelism: number
  /** Base64, 16–64 bytes. */
  salt: string
}

export interface Pbkdf2Params {
  alg: 'pbkdf2-hmac-sha512'
  iterations: number
  /** Base64, 16–64 bytes; new vaults use 32. */
  salt: string
}

export type KdfParams = Argon2idParams | Pbkdf2Params

/** Only unit tests pass this, to keep the KDFs cheap; ceilings still apply. */
export interface WeakKdfOption {
  allowWeakForTests?: boolean
}

export class BadKdf extends Error {
  override name = 'BadKdf'
}

const MiB = 1024
const ARGON2 = { floor: { memoryKiB: 64 * MiB, passes: 2 }, ceiling: { memoryKiB: 1024 * MiB, passes: 10 } }
/** SP 800-132 with the profile's floor (audit §4.1); the module's own range is [1000, 10^7]. */
export const PBKDF2_RANGE = { min: 600_000, max: 10_000_000 } as const
const SALT = { min: 16, max: 64 }
const PBKDF2_SALT_BYTES = 32

/** Strict base64 decode: only the canonical padded encoding is accepted. */
export function decodeB64(s: unknown): Buffer | null {
  if (typeof s !== 'string') return null
  const b = Buffer.from(s, 'base64')
  return b.toString('base64') === s ? b : null
}

const int = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n)

/** Floors and ceilings of §3 and audit §4.1, checked before any derivation whatever the header's source. */
export function validateKdf(kdf: KdfParams, opts: WeakKdfOption = {}): void {
  const weak = opts.allowWeakForTests === true
  const salt = decodeB64(kdf.salt)
  if (kdf.alg === 'argon2id') {
    if (!int(kdf.memoryKiB) || !int(kdf.passes) || kdf.parallelism !== 1) throw new BadKdf('Bad key derivation parameters')
    if (!salt) throw new BadKdf('Bad salt')
    if (kdf.memoryKiB > ARGON2.ceiling.memoryKiB || kdf.passes > ARGON2.ceiling.passes || salt.length > SALT.max) {
      throw new BadKdf('Key derivation parameters are too large')
    }
    // The module refuses Argon2id below 32 KiB, and OpenSSL a salt below 8 bytes, even in tests.
    const floor = weak ? { memoryKiB: 32, passes: 1, salt: 8 } : { ...ARGON2.floor, salt: SALT.min }
    if (kdf.memoryKiB < floor.memoryKiB || kdf.passes < floor.passes || salt.length < floor.salt) {
      throw new BadKdf('Key derivation parameters are too weak')
    }
    return
  }
  if (kdf.alg === 'pbkdf2-hmac-sha512') {
    if (!int(kdf.iterations)) throw new BadKdf('Bad key derivation parameters')
    if (!salt) throw new BadKdf('Bad salt')
    if (kdf.iterations > PBKDF2_RANGE.max || salt.length > SALT.max) throw new BadKdf('Key derivation parameters are too large')
    const floor = weak ? { iterations: 1000, salt: 8 } : { iterations: PBKDF2_RANGE.min, salt: SALT.min }
    if (kdf.iterations < floor.iterations || salt.length < floor.salt) throw new BadKdf('Key derivation parameters are too weak')
    return
  }
  throw new BadKdf('Unsupported key derivation')
}

/**
 * KEK_pw as a module handle (password class: it wraps and unwraps MK and nothing else). The password arrives
 * as bytes, NFC then UTF-8, from the renderer (Z-5, C7) and is never a string in this process. The module
 * gets its own copy, which it moves into its secure heap and wipes before the derivation starts on a libuv
 * thread (Argon2id, and PBKDF2 in the FIPS library context: review C5 L1); `password` stays its owner's to zero (the IPC handler does, when the call settles). The caller
 * destroys the returned handle.
 */
export async function deriveKek(password: SecretBytes, kdf: KdfParams, opts: WeakKdfOption = {}): Promise<KeyHandle> {
  validateKdf(kdf, opts)
  const salt = decodeB64(kdf.salt)
  if (!salt) throw new BadKdf('Bad salt')
  return derive(password, salt, kdf)
}

/** The one place a password KEK is derived: the vault's KDF, and the self-test's known answer below. */
function derive(password: SecretBytes, salt: Uint8Array, kdf: KdfParams): Promise<KeyHandle> {
  const n = vaultNative()
  if (kdf.alg === 'pbkdf2-hmac-sha512') return n.pbkdf2Async(moduleCopy(password), salt, kdf.iterations)
  return n.argon2idAsync(moduleCopy(password), salt, kdf.memoryKiB, kdf.passes)
}

/**
 * The power-up self-test's known answer for each password KDF (vault/selftest, audit Appendix A): fixed public
 * inputs at the module's minimum cost, through the same derivation as `deriveKek`. It takes no parameters, so it
 * derives nothing but these two vectors; a vault's KDF always goes through `deriveKek` and its floors.
 */
export function selfTestKek(alg: KdfParams['alg']): Promise<KeyHandle> {
  const password = utf8('slate-kat-password')
  if (alg === 'pbkdf2-hmac-sha512') return derive(password, new Uint8Array(32).fill(0x5a), { alg, iterations: 1000, salt: '' })
  return derive(password, new Uint8Array(16).fill(0x5a), { alg, memoryKiB: 32, passes: 3, parallelism: 1, salt: '' })
}

export function defaultKdf(): Argon2idParams {
  return { alg: 'argon2id', memoryKiB: 256 * MiB, passes: 4, parallelism: 1, salt: toBase64(vaultNative().randomBytes(16)) }
}

async function timeDerivation(kdf: KdfParams): Promise<number> {
  const t = performance.now()
  destroyKey(await deriveKek(utf8('calibration'), kdf))
  return performance.now() - t
}

/**
 * Argon2id aims at about a second: the default (~0.6 s on Apple Silicon) unless this machine is much slower,
 * then half the memory with the same passes, which is still well above the floors.
 */
export async function calibrateKdf(measure: (kdf: KdfParams) => Promise<number> = timeDerivation): Promise<Argon2idParams> {
  const kdf = defaultKdf()
  if ((await measure(kdf)) <= 1500) return kdf
  return { ...kdf, memoryKiB: 128 * MiB }
}

/** PBKDF2-HMAC-SHA-512 for the fips-140-3 profile: iterations the module times to about 1 s, a 32-byte salt. */
export function calibratePbkdf2(targetMs = 1000): Pbkdf2Params {
  const n = vaultNative()
  return { alg: 'pbkdf2-hmac-sha512', iterations: n.pbkdf2Calibrate(targetMs), salt: toBase64(n.randomBytes(PBKDF2_SALT_BYTES)) }
}

/** The KDF a new vault under `profile` gets; `cheap` (tests and the e2e hook) keeps it at the test floor. */
export async function kdfForProfile(profile: ProfileId, cheap?: { argon2: Pick<Argon2idParams, 'memoryKiB' | 'passes'>; pbkdf2Iterations: number }): Promise<KdfParams> {
  if (profile === 'fips-140-3') {
    if (cheap) return { alg: 'pbkdf2-hmac-sha512', iterations: cheap.pbkdf2Iterations, salt: toBase64(vaultNative().randomBytes(PBKDF2_SALT_BYTES)) }
    return calibratePbkdf2()
  }
  if (cheap) return { ...defaultKdf(), ...cheap.argon2 }
  return calibrateKdf()
}
