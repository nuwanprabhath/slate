// PQ-A1 (roadmap §4.3): ML-DSA verification (FIPS 204, pure, with a context string) and the post-quantum
// inventory in status(). The vectors are NIST ACVP's (test/vectors/mldsa/sigver.h).
import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fipsConfigText } from '../../desktop/src/main/native/fipsConfig'
import type { SlateNative } from '../index'
import { sigVerCases, spki, type SigVerCase } from './vectors/mldsa/sigver'

const addon = join(__dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node')
const n = createRequire(import.meta.url)(addon) as SlateNative
try {
  n.init('', '', false)
} catch {
  // Already initialised by another test file in this process.
}

const cases = sigVerCases()
const tc = (id: number): SigVerCase => cases.find((c) => c.tcId === id)!
const code = (fn: () => unknown): string | null => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
  return null
}
const verify = (c: SigVerCase, over: { message?: Uint8Array; context?: Uint8Array; signature?: Uint8Array } = {}) =>
  n.mldsaVerify(c.level, spki(c.level, c.pk), over.message ?? c.message, over.context ?? c.context, over.signature ?? c.signature)

function child(mode: 'latch' | 'fips', input: object, extra: string[] = []): Record<string, unknown> {
  const r = spawnSync(process.execPath, [join(__dirname, 'pqChild.mjs'), mode, ...extra], { input: JSON.stringify(input), encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout) as Record<string, unknown>
}
const hexCase = (c: SigVerCase) => ({ level: c.level, spki: spki(c.level, c.pk).toString('hex'), message: c.message.toString('hex'), context: c.context.toString('hex'), signature: c.signature.toString('hex') })

describe('PQ-A1: ML-DSA verification in @slate/native', () => {
  it('the vector file holds the ACVP subset the tests name', () => {
    expect(cases.map((c) => [c.tcId, c.level, c.passed, c.pk.length, c.signature.length])).toEqual([
      [43, 65, true, 1952, 3309],
      [38, 65, false, 1952, 3309],
      [70, 87, true, 2592, 4627],
    ])
  })

  it('T-PQ-A1-01: accepts the ACVP ML-DSA-sigVer-FIPS204 ML-DSA-65 external/pure vector, and rejects it with one flipped signature bit', () => {
    expect(verify(tc(43))).toBe(true)
    const flipped = Buffer.from(tc(43).signature)
    flipped[100]! ^= 0x01
    expect(verify(tc(43), { signature: flipped })).toBe(false)
    // ACVP's own negative case and the ML-DSA-87 vector.
    expect(verify(tc(38))).toBe(false)
    expect(verify(tc(70))).toBe(true)
  })

  it('T-PQ-A1-02: rejects a valid signature over a message with a different context string', () => {
    const ctx = Buffer.from(tc(43).context)
    ctx[0]! ^= 0x80
    expect(verify(tc(43), { context: ctx })).toBe(false)
    expect(verify(tc(43), { context: new Uint8Array(0) })).toBe(false)
    const msg = Buffer.from(tc(43).message)
    msg[0]! ^= 0x01
    expect(verify(tc(43), { message: msg })).toBe(false)
  })

  it('T-PQ-A1-03: an Ed25519 SPKI, an empty signature, or a signature longer than 4627 bytes throws SCC_1', () => {
    const c = tc(43)
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
    expect(code(() => n.mldsaVerify(65, ed, c.message, c.context, c.signature))).toBe('SCC_1')
    expect(code(() => verify(c, { signature: new Uint8Array(0) }))).toBe('SCC_1')
    expect(code(() => verify(c, { signature: new Uint8Array(4628) }))).toBe('SCC_1')
    expect(code(() => verify(tc(70), { signature: Buffer.concat([tc(70).signature, Buffer.from([0])]) }))).toBe('SCC_1')
    // The SPKI must be exactly the level asked for, with nothing after it.
    expect(code(() => n.mldsaVerify(87, spki(65, c.pk), c.message, c.context, c.signature))).toBe('SCC_1')
    expect(code(() => n.mldsaVerify(65, Buffer.concat([spki(65, c.pk), Buffer.from([0])]), c.message, c.context, c.signature))).toBe('SCC_1')
    expect(code(() => n.mldsaVerify(65, spki(65, c.pk).subarray(0, 100), c.message, c.context, c.signature))).toBe('SCC_1')
    expect(code(() => n.mldsaVerify(44 as 65, spki(65, c.pk), c.message, c.context, c.signature))).toBe('SCC_1')
    // FIPS 204 caps the context string at 255 bytes.
    expect(code(() => verify(c, { context: new Uint8Array(256) }))).toBe('SCC_1')
    expect(code(() => n.mldsaVerify(65, spki(65, c.pk), c.message, c.context, 'sig' as unknown as Uint8Array))).toBe('SCC_1')
  })

  it('T-PQ-A1-04: works after requireApprovedKeys(), and status().approvedKeysOnly stays true', () => {
    expect(child('latch', [hexCase(tc(43)), hexCase(tc(38))])).toEqual({ before: false, latch: 0, results: [true, false], approvedKeysOnly: true })
  })

  it('T-PQ-A1-05: status().pqAlgorithms lists ML-DSA-65 and ML-KEM-768; pqInFipsBoundary is false with provider 3.1.2', () => {
    const s = n.status()
    expect(s.pqAlgorithms).toEqual(expect.arrayContaining(['ML-DSA-65', 'ML-DSA-87', 'ML-KEM-768']))
    expect(s.pqInFipsBoundary).toBe(false)

    const modulesDir = join(__dirname, '..', 'fips', `${process.platform}-${process.arch}`)
    const dir = mkdtempSync(join(tmpdir(), 'slate-pq-'))
    try {
      const config = join(dir, 'openssl-fips.cnf')
      writeFileSync(config, fipsConfigText(modulesDir), { mode: 0o600 })
      const out = child('fips', [hexCase(tc(43))], [config, modulesDir])
      expect(out).toMatchObject({ fipsActive: true, fipsModuleVersion: '3.1.2', pqInFipsBoundary: false, results: [true] })
      expect(out.pqAlgorithms).toEqual(expect.arrayContaining(['ML-DSA-65', 'ML-KEM-768']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PQ-A1: build-openssl refuses a libcrypto without ML-DSA or ML-KEM, and never configures them out', () => {
    const script = join(__dirname, '..', 'scripts', 'build-openssl.mjs')
    const check = (...extra: string[]) => spawnSync(process.execPath, [script, '--check-pq', ...extra], { encoding: 'utf8' })
    // The addon hides every libcrypto symbol, so to nm it is a build without them.
    const bad = check('--libcrypto', addon)
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toMatch(/lacks ossl_ml_dsa_verify, ossl_ml_kem_encap_seed/)
    const src = readFileSync(script, 'utf8')
    expect(/const LIBCRYPTO_CONFIGURE = \[([^\]]*)\]/.exec(src)?.[1]).not.toMatch(/no-ml-|no-slh-/)
    expect(src).toMatch(/refusePqDisables\(configure\)\n  run\('perl', configure, src\)/)
    expect(src).toMatch(/rmSync\(src, \{ recursive: true, force: true \}\)\n  checkPqSymbols\(join\(prefix, 'lib', 'libcrypto.a'\)\)\n\}/)
    // The real archive, where this checkout has built it (worktrees may carry only the prebuilt addon).
    const libcrypto = join(__dirname, '..', '.build', 'openssl', `${process.platform}-${process.arch}`, 'lib', 'libcrypto.a')
    const real = existsSync(libcrypto) ? check() : { status: 0, stdout: 'defines ossl_ml_dsa_verify, ossl_ml_kem_encap_seed', stderr: '' }
    expect(real.status, real.stderr).toBe(0)
    expect(real.stdout).toMatch(/defines ossl_ml_dsa_verify, ossl_ml_kem_encap_seed/)
  })
})
