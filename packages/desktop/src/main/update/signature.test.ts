import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  artifactMessage,
  keyIdOf,
  manifestMessage,
  parseManifest,
  parseSignatureFile,
  PINNED_UPDATE_KEYS,
  UpdateSignatureError,
  verifyDetached,
  type PinnedUpdateKey,
} from './signature'

function keyPair(): { key: PinnedUpdateKey; signBytes(m: Uint8Array): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { key: { alg: 'ed25519', publicKeyPem: pem }, signBytes: (m) => sign(null, m, privateKey).toString('base64') }
}

function sigFile(alg: string, key: PinnedUpdateKey, signature: string): string {
  return JSON.stringify({ format: 'slate-update-signature', version: 1, alg, keyId: keyIdOf(key.publicKeyPem), signature })
}

const MANIFEST = `version: 0.2.0
files:
  - url: Slate-0.2.0-mac-arm64.zip
    sha512: aGVsbG8=
    size: 10
  - url: 'Slate-0.2.0-mac-arm64.dmg'
    sha512: "d29ybGQ="
    size: 20
path: Slate-0.2.0-mac-arm64.zip
sha512: aGVsbG8=
releaseDate: '2026-10-23T00:00:00.000Z'
`

describe('update signatures (C12)', () => {
  it('pins the maintainer key, an Ed25519 SPKI with a stable key id', () => {
    expect(PINNED_UPDATE_KEYS.length).toBeGreaterThan(0)
    const first = PINNED_UPDATE_KEYS[0]!
    expect(first.alg).toBe('ed25519')
    expect(keyIdOf(first.publicKeyPem)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('verifies a manifest signed by a pinned key', () => {
    const k = keyPair()
    const bytes = new TextEncoder().encode(MANIFEST)
    const sig = sigFile('ed25519', k.key, k.signBytes(manifestMessage('latest-mac.yml', bytes)))
    expect(verifyDetached(manifestMessage('latest-mac.yml', bytes), sig, [k.key])).toBe(keyIdOf(k.key.publicKeyPem))
  })

  it('T-UPD-02: a manifest signed by the next pinned key verifies', () => {
    const current = keyPair()
    const next = keyPair()
    const m = artifactMessage('Slate.dmg', 'abc=')
    expect(verifyDetached(m, sigFile('ed25519', next.key, next.signBytes(m)), [current.key, next.key])).toBe(keyIdOf(next.key.publicKeyPem))
  })

  it('refuses a tampered message, an unpinned key, an unknown alg and a malformed file', () => {
    const k = keyPair()
    const other = keyPair()
    const m = artifactMessage('Slate.dmg', 'abc=')
    const good = sigFile('ed25519', k.key, k.signBytes(m))
    expect(() => verifyDetached(artifactMessage('Slate.dmg', 'abd='), good, [k.key])).toThrow(UpdateSignatureError)
    expect(() => verifyDetached(m, good, [other.key])).toThrow(/not pinned/)
    expect(() => verifyDetached(m, sigFile('ml-dsa-65+ed25519', k.key, k.signBytes(m)), [k.key])).toThrow(/algorithm/)
    expect(() => verifyDetached(m, sigFile('ed25519', k.key, other.signBytes(m)), [k.key])).toThrow(/does not verify/)
    expect(() => verifyDetached(m, 'not json', [k.key])).toThrow(UpdateSignatureError)
    expect(() => verifyDetached(m, JSON.stringify({ alg: 'ed25519' }), [k.key])).toThrow(UpdateSignatureError)
    expect(() => verifyDetached(m, good + ' '.repeat(5000), [k.key])).toThrow(/too large/)
  })

  it('keeps the manifest and artefact messages apart, so one signature cannot stand in for the other', () => {
    const k = keyPair()
    const asArtifact = artifactMessage('latest-mac.yml', 'x')
    const sig = sigFile('ed25519', k.key, k.signBytes(asArtifact))
    expect(() => verifyDetached(manifestMessage('latest-mac.yml', new TextEncoder().encode('x')), sig, [k.key])).toThrow(UpdateSignatureError)
  })

  it('parses the signature file strictly', () => {
    const k = keyPair()
    const parsed = parseSignatureFile(sigFile('ed25519', k.key, 'AAAA'))
    expect(parsed).toEqual({ alg: 'ed25519', keyId: keyIdOf(k.key.publicKeyPem), signature: 'AAAA' })
    expect(() => parseSignatureFile(JSON.stringify({ format: 'slate-update-signature', version: 2, alg: 'ed25519', keyId: 'a', signature: 'b' }))).toThrow(/version/)
  })

  it('reads the version and the files of an electron-builder feed', () => {
    expect(parseManifest(MANIFEST)).toEqual({
      version: '0.2.0',
      files: [
        { url: 'Slate-0.2.0-mac-arm64.zip', sha512: 'aGVsbG8=' },
        { url: 'Slate-0.2.0-mac-arm64.dmg', sha512: 'd29ybGQ=' },
      ],
    })
  })
})
