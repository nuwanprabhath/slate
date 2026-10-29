import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_ED25519_PKCS8_B64 } from './fakeHybridKey'
import { HYBRID_ALG, PINNED_UPDATE_KEYS, artifactMessage, manifestMessage, pinnedKeyId, verifyDetached, type HybridUpdateKey, type PinnedUpdateKey } from './signature'

// The release workflow's signer (scripts/sign-update.mjs) and the app's verifier must agree byte for byte.
// The signer runs under this runtime (Electron's Node, BoringSSL), which signs ML-DSA-65 from a seed-form PKCS#8
// key; the release job runs it under Node 24 (OpenSSL 3.5).
const SCRIPT = join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'sign-update.mjs')
const SIGNATURE_TS = join(__dirname, 'signature.ts')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'slate-sign-'))
  dirs.push(dir)
  return dir
}

function release() {
  const dir = tempDir()
  const deb = Buffer.from('deb bytes')
  const sha = createHash('sha512').update(deb).digest('base64')
  writeFileSync(join(dir, 'Slate-0.2.0-linux-amd64.deb'), deb)
  writeFileSync(join(dir, 'latest-linux.yml'), `version: 0.2.0\nfiles:\n  - url: Slate-0.2.0-linux-amd64.deb\n    sha512: ${sha}\n    size: ${deb.length}\n`)
  writeFileSync(join(dir, 'slate-sbom.cdx.json'), '{"bomFormat":"CycloneDX"}')
  return { dir, sha }
}

const spkiB64 = (k: KeyObject) => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('base64')
const pkcs8Pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString()

interface SigningKeys {
  /** The v1 pin: Ed25519 alone. */
  v1: PinnedUpdateKey
  hybrid: HybridUpdateKey
  edPrivatePem: string
  mlPrivatePem: string
}

function keysFrom(ed: KeyObject, ml: KeyObject): SigningKeys {
  const ed25519Pem = createPublicKey(ed).export({ type: 'spki', format: 'pem' }).toString()
  return {
    v1: { alg: 'ed25519', publicKeyPem: ed25519Pem },
    hybrid: { alg: HYBRID_ALG, ed25519Pem, mldsa65SpkiB64: spkiB64(ml) },
    edPrivatePem: pkcs8Pem(ed),
    mlPrivatePem: pkcs8Pem(ml),
  }
}

/**
 * A fresh ML-DSA-65 key as seed-only PKCS#8 (RFC 9881: the OID 2.16.840.1.101.3.4.3.18, then [0] and the 32-byte
 * seed), the one private-key form both BoringSSL and OpenSSL read; @types/node has no 'ml-dsa-65' key type yet.
 */
function mldsaKey(): KeyObject {
  const prefix = Buffer.from('3034020100300b060960864801650304031204228020', 'hex')
  return createPrivateKey({ key: Buffer.concat([prefix, randomBytes(32)]), format: 'der', type: 'pkcs8' })
}

function keys(): SigningKeys {
  return keysFrom(generateKeyPairSync('ed25519').privateKey, mldsaKey())
}

/** signature.ts itself with its pinned hybrid key swapped for `pin`, so the signer reads the file's real shape. */
function pinnedSource(pin: HybridUpdateKey): string {
  const real = PINNED_UPDATE_KEYS.find((k): k is HybridUpdateKey => k.alg === HYBRID_ALG)
  if (!real) throw new Error('signature.ts pins no hybrid key')
  const edB64 = (pem: string) => createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64')
  const text = readFileSync(SIGNATURE_TS, 'utf8')
  expect(text).toContain(edB64(real.ed25519Pem))
  expect(text).toContain(real.mldsa65SpkiB64)
  return text.replace(edB64(real.ed25519Pem), edB64(pin.ed25519Pem)).replace(real.mldsa65SpkiB64, pin.mldsa65SpkiB64)
}

function run(dir: string, k: { edPrivatePem: string; mlPrivatePem: string }, pinned: string) {
  const pinnedFile = join(tempDir(), 'pinned.ts')
  writeFileSync(pinnedFile, pinned)
  return spawnSync(process.execPath, [SCRIPT, dir, '--pinned', pinnedFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLATE_UPDATE_SIGNING_KEY: k.edPrivatePem, SLATE_UPDATE_SIGNING_KEY_MLDSA: k.mlPrivatePem },
    encoding: 'utf8',
  })
}

const signatureFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.sig'))

describe('scripts/sign-update.mjs', () => {
  it('writes .sig files the app verifies: the feed, each artefact and the SBOM', () => {
    const { dir, sha } = release()
    const k = keys()
    const out = run(dir, k, pinnedSource(k.hybrid))
    expect(out.status, out.stderr).toBe(0)
    const feed = readFileSync(join(dir, 'latest-linux.yml'))
    expect(() => verifyDetached(manifestMessage('latest-linux.yml', feed), readFileSync(join(dir, 'latest-linux.yml.sig'), 'utf8'), [k.v1])).not.toThrow()
    const debSig = readFileSync(join(dir, 'Slate-0.2.0-linux-amd64.deb.sig'), 'utf8')
    expect(JSON.parse(debSig)).toMatchObject({ alg: 'ed25519' })
    expect(() => verifyDetached(artifactMessage('Slate-0.2.0-linux-amd64.deb', sha), debSig, [k.v1])).not.toThrow()
    const sbom = readFileSync(join(dir, 'slate-sbom.cdx.json'))
    const sbomSha = createHash('sha512').update(sbom).digest('base64')
    expect(() => verifyDetached(artifactMessage('slate-sbom.cdx.json', sbomSha), readFileSync(join(dir, 'slate-sbom.cdx.json.sig'), 'utf8'), [k.v1])).not.toThrow()
  })

  it('refuses without a key, with a key the app does not pin, and when a file does not match its feed', () => {
    const k = keys()
    const a = release()
    expect(run(a.dir, { ...k, edPrivatePem: '' }, pinnedSource(k.hybrid)).status).not.toBe(0)
    const b = release()
    const unpinned = run(b.dir, k, pinnedSource(keys().hybrid))
    expect(unpinned.status).not.toBe(0)
    expect(unpinned.stderr).toMatch(/not pinned/)
    const c = release()
    writeFileSync(join(c.dir, 'Slate-0.2.0-linux-amd64.deb'), 'tampered')
    const mismatch = run(c.dir, k, pinnedSource(k.hybrid))
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toMatch(/sha512/)
  })
  it('review F5: refuses a feed whose entries it cannot read, instead of skipping the check', () => {
    const k = keys()
    const a = release()
    const feed = join(a.dir, 'latest-linux.yml')
    // Same data, keys in another order: the url/sha512 pairing no longer matches.
    writeFileSync(feed, `version: 0.2.0\nfiles:\n  - sha512: ${a.sha}\n    url: Slate-0.2.0-linux-amd64.deb\n    size: 9\n`)
    const out = run(a.dir, k, pinnedSource(k.hybrid))
    expect(out.status).not.toBe(0)
    expect(out.stderr).toMatch(/entries/)
    const b = release()
    writeFileSync(join(b.dir, 'latest-linux.yml'), 'version: 0.2.0\nfiles: []\n')
    expect(run(b.dir, k, pinnedSource(k.hybrid)).status).not.toBe(0)
  })

  it('T-PQ-A3-01: signs a release with both files, and signature.ts verifies each .pq.sig with the pinned hybrid key', () => {
    const { dir, sha } = release()
    const k = keys()
    const out = run(dir, k, pinnedSource(k.hybrid))
    expect(out.status, out.stderr).toBe(0)
    const names = ['latest-linux.yml', 'Slate-0.2.0-linux-amd64.deb', 'slate-sbom.cdx.json']
    expect(signatureFiles(dir).sort()).toEqual(names.flatMap((n) => [`${n}.pq.sig`, `${n}.sig`]).sort())
    const message = (name: string) => {
      const bytes = readFileSync(join(dir, name))
      if (name === 'latest-linux.yml') return manifestMessage(name, bytes)
      return artifactMessage(name, name.endsWith('.deb') ? sha : createHash('sha512').update(bytes).digest('base64'))
    }
    const keyId = pinnedKeyId(k.hybrid)
    for (const name of names) {
      const pq = readFileSync(join(dir, `${name}.pq.sig`), 'utf8')
      expect(Object.keys(JSON.parse(pq) as object)).toEqual(['format', 'version', 'alg', 'keyId', 'sig'])
      expect(verifyDetached(message(name), pq, [k.hybrid]), name).toBe(keyId)
      // The v1 file is still there for clients up to 0.3.x, and it is not a hybrid file.
      expect(verifyDetached(message(name), readFileSync(join(dir, `${name}.sig`), 'utf8'), [k.v1]), name).toMatch(/^[0-9a-f]{16}$/)
    }
    // Another hybrid key does not verify what this one signed.
    expect(() => verifyDetached(message('latest-linux.yml'), readFileSync(join(dir, 'latest-linux.yml.pq.sig'), 'utf8'), [keys().hybrid])).toThrow(/not pinned/)
  })

  it('T-PQ-A3-02: an ML-DSA key that is not the pinned hybrid key\'s ML-DSA half, or none, exits non-zero and writes no signature', () => {
    const k = keys()
    const other = keys()
    // The Ed25519 half is pinned, but beside another ML-DSA key.
    const a = release()
    const mismatched = run(a.dir, k, pinnedSource({ ...k.hybrid, mldsa65SpkiB64: other.hybrid.mldsa65SpkiB64 }))
    expect(mismatched.status).not.toBe(0)
    expect(mismatched.stderr).toMatch(/ML-DSA-65 public key .* is not pinned/)
    expect(signatureFiles(a.dir)).toEqual([])
    // Both halves are pinned, but in two different hybrid keys.
    const b = release()
    const split = run(b.dir, k, `${pinnedSource({ ...k.hybrid, mldsa65SpkiB64: other.hybrid.mldsa65SpkiB64 })}\n${pinnedSource({ ...other.hybrid, mldsa65SpkiB64: k.hybrid.mldsa65SpkiB64 })}`)
    expect(split.status).not.toBe(0)
    expect(signatureFiles(b.dir)).toEqual([])
    // No ML-DSA key at all: never a v1-only release.
    const c = release()
    const missing = run(c.dir, { ...k, mlPrivatePem: '' }, pinnedSource(k.hybrid))
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toMatch(/SLATE_UPDATE_SIGNING_KEY_MLDSA is empty/)
    expect(signatureFiles(c.dir)).toEqual([])
    // An Ed25519 key where the ML-DSA key belongs.
    const d = release()
    const wrongType = run(d.dir, { ...k, mlPrivatePem: k.edPrivatePem }, pinnedSource(k.hybrid))
    expect(wrongType.status).not.toBe(0)
    expect(wrongType.stderr).toMatch(/not ml-dsa-65/)
    expect(signatureFiles(d.dir)).toEqual([])
    // The app's own pinned key file refuses a generated key.
    const e = release()
    const real = spawnSync(process.execPath, [SCRIPT, e.dir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLATE_UPDATE_SIGNING_KEY: k.edPrivatePem, SLATE_UPDATE_SIGNING_KEY_MLDSA: k.mlPrivatePem },
      encoding: 'utf8',
    })
    expect(real.status).not.toBe(0)
    expect(real.stderr).toMatch(/not pinned/)
    expect(existsSync(join(e.dir, 'latest-linux.yml.pq.sig'))).toBe(false)
  })

  it('T-PQ-A3-03: the v1 .sig files are byte-identical to the v0.3.0 signer\'s for the same input and key', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sign-update-v0.3.0.json'), 'utf8')) as { inputs: Record<string, string>; sigs: Record<string, string> }
    const dir = tempDir()
    for (const [name, text] of Object.entries(fixture.inputs)) writeFileSync(join(dir, name), text)
    const ed = createPrivateKey({ key: Buffer.from(FAKE_ED25519_PKCS8_B64, 'base64'), format: 'der', type: 'pkcs8' })
    const k = keysFrom(ed, mldsaKey())
    const out = run(dir, k, pinnedSource(k.hybrid))
    expect(out.status, out.stderr).toBe(0)
    expect(Object.keys(fixture.sigs).sort()).toEqual(Object.keys(fixture.inputs).map((n) => `${n}.sig`).sort())
    for (const [name, text] of Object.entries(fixture.sigs)) expect(readFileSync(join(dir, name), 'utf8'), name).toBe(text)
    for (const name of Object.keys(fixture.inputs)) expect(existsSync(join(dir, `${name}.pq.sig`)), name).toBe(true)
  })
})
