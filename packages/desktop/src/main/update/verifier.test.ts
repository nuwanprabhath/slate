import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { artifactMessage, keyIdOf, manifestMessage, UpdateSignatureError, type PinnedUpdateKey } from './signature'
import { createUpdateVerifier, sameRelease } from './verifier'

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const key: PinnedUpdateKey = { alg: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const sigFile = (m: Uint8Array) =>
    JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId: keyIdOf(key.publicKeyPem), signature: sign(null, m, privateKey).toString('base64') })
  return { key, sigFile }
}

const NAME = 'latest-linux.yml'
const yml = `version: 0.2.0
files:
  - url: Slate-0.2.0-linux-amd64.deb
    sha512: ZGVi
    size: 3
  - url: Slate-0.2.0-x86_64.AppImage
    sha512: YXBw
    size: 3
path: Slate-0.2.0-x86_64.AppImage
`
const found = {
  version: '0.2.0',
  files: [
    { url: 'Slate-0.2.0-linux-amd64.deb', sha512: 'ZGVi', size: 3 },
    { url: 'Slate-0.2.0-x86_64.AppImage', sha512: 'YXBw', size: 3 },
  ],
}

/** A release as the GitHub feed would serve it; drop or replace files to model an attack or an old release. */
function release(signer = keyPair(), opts: { unsigned?: boolean; manifestText?: string } = {}) {
  const enc = new TextEncoder()
  const assets = new Map<string, Uint8Array>()
  const text = opts.manifestText ?? yml
  assets.set(NAME, enc.encode(text))
  if (!opts.unsigned) {
    assets.set(`${NAME}.sig`, enc.encode(signer.sigFile(manifestMessage(NAME, enc.encode(text)))))
    for (const f of found.files) assets.set(`${f.url}.sig`, enc.encode(signer.sigFile(artifactMessage(f.url, f.sha512))))
  }
  return assets
}

function verifier(assets: Map<string, Uint8Array>, keys: PinnedUpdateKey[], opts: { currentVersion?: string } = {}) {
  return createUpdateVerifier({
    keys,
    manifestName: NAME,
    currentVersion: opts.currentVersion ?? '0.1.0',
    fetchAsset: async (_version, name) => assets.get(name) ?? null,
  })
}

describe('update verifier (C12 criterion 1)', () => {
  it('trusts a release whose feed and artefacts verify under a pinned key', async () => {
    const k = keyPair()
    const v = verifier(release(k), [k.key])
    const verified = await v.release(found)
    expect(verified).toMatchObject({ version: '0.2.0' })
    await expect(v.artifact(verified, found.files[0]!)).resolves.toBeUndefined()
  })

  it('T-UPD-01: refuses an invalid feed signature', async () => {
    const v = verifier(release(keyPair()), [keyPair().key])
    await expect(v.release(found)).rejects.toThrow(UpdateSignatureError)
  })

  it('T-UPD-01: refuses a missing feed signature, always: no build with this code accepts an unsigned release', async () => {
    // Review F1: the audit's one-time allowance was for clients that cannot verify (v0.1.0); a verifying client never needs it.
    const assets = release(keyPair(), { unsigned: true })
    const v = verifier(assets, [keyPair().key])
    await expect(v.release(found)).rejects.toThrow(/unsigned/)
    await expect(v.release({ ...found, version: '0.3.0' })).rejects.toThrow(UpdateSignatureError)
  })

  it('N1: refuses a signed release that is not newer than the running version (no rollback)', async () => {
    const k = keyPair()
    await expect(verifier(release(k), [k.key], { currentVersion: '0.2.0' }).release(found)).rejects.toThrow(/not newer/)
    await expect(verifier(release(k), [k.key], { currentVersion: '0.3.0' }).release(found)).rejects.toThrow(/not newer/)
  })

  it('sameRelease holds only for the exact version and file hashes that verified', async () => {
    const k = keyPair()
    const verified = await verifier(release(k), [k.key]).release(found)
    expect(sameRelease(found, verified)).toBe(true)
    expect(sameRelease({ ...found, version: '0.3.0' }, verified)).toBe(false)
    expect(sameRelease({ ...found, files: [found.files[0]!, { ...found.files[1]!, sha512: 'RVZJTA==' }] }, verified)).toBe(false)
    expect(sameRelease({ ...found, files: [...found.files, { url: 'extra.AppImage', sha512: 'eA==' }] }, verified)).toBe(false)
    expect(sameRelease(null, verified)).toBe(false)
  })

  it('refuses a signed feed that does not list what electron-updater offers', async () => {
    const k = keyPair()
    const v = verifier(release(k, { manifestText: yml.replace('YXBw', 'ZXZpbA==') }), [k.key])
    await expect(v.release(found)).rejects.toThrow(/sha512/)
    const v2 = verifier(release(k, { manifestText: yml.replace('version: 0.2.0', 'version: 0.1.9') }), [k.key])
    await expect(v2.release(found)).rejects.toThrow(/version/)
  })

  it('refuses a signed release whose artefact signature is missing or wrong', async () => {
    const k = keyPair()
    const assets = release(k)
    assets.delete(`${found.files[0]!.url}.sig`)
    const v = verifier(assets, [k.key])
    const verified = await v.release(found)
    await expect(v.artifact(verified, found.files[0]!)).rejects.toThrow(/missing/)
    await expect(v.artifact(verified, { ...found.files[1]!, sha512: 'b3RoZXI=' })).rejects.toThrow(UpdateSignatureError)
  })
})
