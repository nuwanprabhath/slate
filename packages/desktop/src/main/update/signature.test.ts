import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { spyOnNative } from '../../../test/nativeSpy'
import { FAKE_HYBRID_KEY, fakeEd25519Sign, fakeFeed, pqSigFile } from './fakeBackend'
import { FAKE_MLDSA65_SIGS } from './fakeHybridKey'
import {
  artifactMessage,
  hybridMessage,
  keyIdOf,
  manifestMessage,
  parseManifest,
  parseSignatureFile,
  pinnedKeyId,
  PINNED_UPDATE_KEYS,
  UpdateSignatureError,
  verifyDetached,
  type Ed25519UpdateKey,
  type PinnedUpdateKey,
} from './signature'

const calls = spyOnNative()

/** The Ed25519 key pinned since C12; the hybrid key keeps it as its classical half. */
const MAINTAINER_ED25519_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA70VVxESJ9WwQlDz5/HTCWdyhiNLtEHvkul0LK7SfdXY=\n-----END PUBLIC KEY-----\n'

const LINUX = 'latest-linux.yml'
const feedM = () => manifestMessage(LINUX, fakeFeed())
const keyId = () => pinnedKeyId(FAKE_HYBRID_KEY)
const goodPq = () => pqSigFile(keyId(), { ed25519: fakeEd25519Sign(hybridMessage(keyId(), feedM())), mldsa65: FAKE_MLDSA65_SIGS[LINUX]! })
/** Flips one bit in the middle of a base64 signature, keeping its length. */
const corrupt = (b64: string) => {
  const b = Buffer.from(b64, 'base64')
  b[b.length >> 1]! ^= 0x01
  return b.toString('base64')
}

function keyPair(): { key: Ed25519UpdateKey; signBytes(m: Uint8Array): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { key: { alg: 'ed25519', publicKeyPem: pem }, signBytes: (m) => sign(null, m, privateKey).toString('base64') }
}

function sigFile(alg: string, key: Ed25519UpdateKey, signature: string): string {
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
  it('pins the maintainer key, an Ed25519 SPKI with a stable key id, now inside the hybrid key (D-12)', () => {
    expect(PINNED_UPDATE_KEYS.length).toBeGreaterThan(0)
    const first = PINNED_UPDATE_KEYS[0]!
    expect(first.alg).toBe('ml-dsa-65+ed25519')
    expect(first.alg === 'ml-dsa-65+ed25519' && keyIdOf(first.ed25519Pem)).toBe(keyIdOf(MAINTAINER_ED25519_PEM))
    // The ML-DSA-65 half is the key from the maintainer's ceremony (§4.8 D-12), by SHA-256 of its DER SPKI.
    expect(first.alg === 'ml-dsa-65+ed25519' && createHash('sha256').update(Buffer.from(first.mldsa65SpkiB64, 'base64')).digest('hex')).toBe(
      '617c0ee26218b5ebfac25d1d0f3b8cef4b1a3be67cabcd08bd9d12b00321995c',
    )
    expect(pinnedKeyId(first)).toMatch(/^[0-9a-f]{16}$/)
    // INV-PQ-8: the hybrid pin makes an Ed25519-only key unreachable, so production pins none.
    expect(PINNED_UPDATE_KEYS.every((k) => k.alg === 'ml-dsa-65+ed25519')).toBe(true)
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

  describe('hybrid ml-dsa-65+ed25519 (PQ-A2)', () => {
    it('T-PQ-A2-01: a feed signed by the pinned hybrid test key verifies', () => {
      expect(verifyDetached(feedM(), goodPq(), [FAKE_HYBRID_KEY])).toBe(keyId())
      // The key id binds both halves: SHA-256 over the Ed25519 SPKI then the ML-DSA SPKI.
      expect(keyId()).toBe('53f93327b27ae0ab')
    })

    it('T-PQ-A2-02: a valid Ed25519 half with a corrupted ML-DSA half is refused, and the other way round', () => {
      const ed = fakeEd25519Sign(hybridMessage(keyId(), feedM()))
      const ml = FAKE_MLDSA65_SIGS[LINUX]!
      expect(() => verifyDetached(feedM(), pqSigFile(keyId(), { ed25519: ed, mldsa65: corrupt(ml) }), [FAKE_HYBRID_KEY])).toThrow(/ML-DSA-65 .*does not verify/)
      expect(() => verifyDetached(feedM(), pqSigFile(keyId(), { ed25519: corrupt(ed), mldsa65: ml }), [FAKE_HYBRID_KEY])).toThrow(/Ed25519 .*does not verify/)
    })

    it('T-PQ-A2-03: with a hybrid key pinned, a correct v1 .sig alone is refused', () => {
      const classic = keyPair()
      const v1 = sigFile('ed25519', classic.key, classic.signBytes(feedM()))
      // The Ed25519-only key is pinned too, and its v1 signature is valid: the hybrid pin still wins (INV-PQ-8).
      expect(() => verifyDetached(feedM(), v1, [classic.key])).not.toThrow()
      for (const keys of [[FAKE_HYBRID_KEY], [classic.key, FAKE_HYBRID_KEY], [FAKE_HYBRID_KEY, classic.key]]) {
        expect(() => verifyDetached(feedM(), v1, keys)).toThrow(UpdateSignatureError)
        expect(() => verifyDetached(feedM(), v1, keys)).toThrow(/post-quantum signature missing/)
      }
    })

    it('T-PQ-A2-04: a component signature over M instead of M\' is refused (domain separation)', () => {
      const edPrime = fakeEd25519Sign(hybridMessage(keyId(), feedM()))
      const edBare = fakeEd25519Sign(feedM())
      const mlBare = FAKE_MLDSA65_SIGS[`unbound:${LINUX}`]!
      expect(() => verifyDetached(feedM(), pqSigFile(keyId(), { ed25519: edBare, mldsa65: FAKE_MLDSA65_SIGS[LINUX]! }), [FAKE_HYBRID_KEY])).toThrow(/Ed25519 .*does not verify/)
      expect(() => verifyDetached(feedM(), pqSigFile(keyId(), { ed25519: edPrime, mldsa65: mlBare }), [FAKE_HYBRID_KEY])).toThrow(/ML-DSA-65 .*does not verify/)
      // M' carries the key id: a signature bound to another key id does not verify under this one.
      expect(() => verifyDetached(feedM(), pqSigFile(keyId(), { ed25519: fakeEd25519Sign(hybridMessage('0000000000000000', feedM())), mldsa65: FAKE_MLDSA65_SIGS[LINUX]! }), [FAKE_HYBRID_KEY])).toThrow(/does not verify/)
      expect(new TextDecoder().decode(hybridMessage(keyId(), new TextEncoder().encode('M')))).toBe(`slate-update/v2|ml-dsa-65+ed25519|${keyId()}|M`)
    })

    it('T-PQ-A2-05: a .pq.sig over 16 KiB, or with unknown keys, is refused before any verify call', () => {
      const good = JSON.parse(goodPq()) as Record<string, unknown>
      const before = calls.get('mldsaVerify') ?? 0
      const bad = [
        goodPq() + ' '.repeat(16 * 1024),
        JSON.stringify({ ...good, extra: 1 }),
        JSON.stringify({ ...good, sig: { ...(good.sig as object), rsa: 'AAAA' } }),
        JSON.stringify({ ...good, sig: { ed25519: (good.sig as { ed25519: string }).ed25519 } }),
        JSON.stringify({ ...good, alg: 'ed25519' }),
        JSON.stringify({ ...good, keyId: 'ABC' }),
        JSON.stringify({ ...good, sig: { ...(good.sig as object), mldsa65: 'AAAA' } }),
        JSON.stringify({ ...good, sig: { ...(good.sig as object), ed25519: '!!' } }),
        'not json',
      ]
      for (const text of bad) expect(() => verifyDetached(feedM(), text, [FAKE_HYBRID_KEY]), text.slice(0, 80)).toThrow(UpdateSignatureError)
      expect(() => verifyDetached(feedM(), goodPq() + ' '.repeat(16 * 1024), [FAKE_HYBRID_KEY])).toThrow(/too large/)
      expect(calls.get('mldsaVerify') ?? 0).toBe(before)
      // The spy does see the module: a well-formed file reaches mldsaVerify once.
      verifyDetached(feedM(), goodPq(), [FAKE_HYBRID_KEY])
      expect(calls.get('mldsaVerify')).toBe(before + 1)
    })

    it('a hybrid signature by a key that is not pinned is refused', () => {
      const ed25519Pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const other: PinnedUpdateKey = { ...FAKE_HYBRID_KEY, ed25519Pem }
      expect(() => verifyDetached(feedM(), goodPq(), [other])).toThrow(/not pinned/)
    })
  })
})
