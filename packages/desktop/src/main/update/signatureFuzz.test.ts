import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { InstallKind } from '../../shared/api'
import { apply, fcRuns, forAll, mutation, type Rng } from '../../../test/fuzz'
import { FAKE_HYBRID_KEY, fakeEd25519Sign, fakeFeed, pqSigFile } from './fakeBackend'
import { FAKE_MLDSA65_SIGS } from './fakeHybridKey'
import { pickInstaller, type UpdateFile } from './pickInstaller'
import {
  hybridMessage,
  keyIdOf,
  manifestMessage,
  parseManifest,
  parsePqSignatureFile,
  parseSignatureFile,
  pinnedKeyId,
  UpdateSignatureError,
  verifyDetached,
  type PinnedUpdateKey,
} from './signature'
import { isNewer, parseVersion } from './versions'

const LINUX = 'latest-linux.yml'
const keyId = pinnedKeyId(FAKE_HYBRID_KEY)
const message = manifestMessage(LINUX, fakeFeed())
const goodPq = pqSigFile(keyId, { ed25519: fakeEd25519Sign(hybridMessage(keyId, message)), mldsa65: FAKE_MLDSA65_SIGS[LINUX]! })

const ed = generateKeyPairSync('ed25519')
const edPem = ed.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const edKey: PinnedUpdateKey = { alg: 'ed25519', publicKeyPem: edPem }
const v1Message = new TextEncoder().encode('v1 message')
const goodV1 = JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId: keyIdOf(edPem), signature: sign(null, v1Message, ed.privateKey).toString('base64') })

/** The parser either returns or throws UpdateSignatureError; anything else is the bug. */
function onlySignatureErrors(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(UpdateSignatureError)
  }
  expect(true).toBe(true)
}

const parsers: Array<[string, (t: string) => unknown, string, number]> = [
  ['parseSignatureFile', parseSignatureFile, goodV1, 4096],
  ['parsePqSignatureFile', parsePqSignatureFile, goodPq, 16 * 1024],
]

/** A valid file with one to four structural mutations, rendered as text. */
function mutated(rng: Rng, base: string): string {
  let o = JSON.parse(base) as Record<string, unknown>
  for (let n = rng.int(1, 4); n > 0; n--) o = apply(o, mutation(rng), rng)
  return JSON.stringify(o)
}

describe('update feed parsers fuzz (F1c)', () => {
  it('T-F1C-01: the fixtures verify, so the mutations start from valid files', () => {
    expect(parseSignatureFile(goodV1).keyId).toBe(keyIdOf(edPem))
    expect(parsePqSignatureFile(goodPq).keyId).toBe(keyId)
    expect(verifyDetached(message, goodPq, [FAKE_HYBRID_KEY])).toBe(keyId)
    expect(verifyDetached(v1Message, goodV1, [edKey])).toBe(keyIdOf(edPem))
  })

  for (const [name, parse, base, cap] of parsers) {
    it(`T-F1C-02: ${name} throws only UpdateSignatureError on arbitrary text`, () => {
      forAll(name, (rng) => onlySignatureErrors(() => parse(rng.string(300))))
    })
    it(`T-F1C-03: ${name} throws only UpdateSignatureError on a mutated valid file`, () => {
      forAll(name, (rng) => onlySignatureErrors(() => parse(mutated(rng, base))))
    })
    it(`T-F1C-04: ${name} refuses text over its size cap before JSON.parse runs`, () => {
      const spy = vi.spyOn(JSON, 'parse')
      try {
        expect(() => parse(' '.repeat(cap + 1))).toThrow(UpdateSignatureError)
        expect(spy).not.toHaveBeenCalled()
        expect(() => parse(' '.repeat(cap))).toThrow(UpdateSignatureError)
        expect(spy).toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  }

  it('T-F1C-05: parseManifest never throws, and returns only entries with a url and sha512', () => {
    const lines = ['version: 1.2.3', 'files:', '  - url: a.dmg', '    sha512: abc', '    size: 3', "  - url: 'b.deb'", 'path: x', '- url: z', '\tsha512: q', '', 'sha512: top']
    forAll('parseManifest', (rng) => {
      const text = rng.bool() ? rng.string(200) : Array.from({ length: rng.int(0, 14) }, () => rng.pick([...lines, rng.string(20)])).join(rng.pick(['\n', '\r\n']))
      const m = parseManifest(text)
      expect(typeof m.version).toBe('string')
      for (const f of m.files) {
        expect(f.url).not.toBe('')
        expect(f.sha512).not.toBe('')
      }
    })
  })

  it('T-F1C-06: verifyDetached throws on any change to the message, whichever key kind is pinned', () => {
    forAll(
      'message',
      (rng) => {
        const [msg, sig, keys] = rng.bool() ? ([message, goodPq, [FAKE_HYBRID_KEY]] as const) : ([v1Message, goodV1, [edKey]] as const)
        const bad = Uint8Array.from(msg)
        const at = rng.int(0, bad.length - 1)
        bad[at] = bad[at]! ^ (1 << rng.int(0, 7))
        expect(() => verifyDetached(bad, sig, [...keys])).toThrow(UpdateSignatureError)
      },
      fcRuns(10).numRuns,
    )
  })

  it('T-F1C-07: verifyDetached throws on any change to a signature', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    forAll(
      'signature',
      (rng) => {
        const pq = rng.bool()
        const o = JSON.parse(pq ? goodPq : goodV1) as { sig?: Record<string, string>; signature?: string }
        const holder: Record<string, string> = pq ? o.sig! : (o as Record<string, string>)
        const field = pq ? rng.pick(['ed25519', 'mldsa65']) : 'signature'
        const s = holder[field]!
        // The last base64 characters carry padding bits that decode to the same bytes, so stay clear of them.
        const at = rng.int(0, s.length - 5)
        holder[field] = s.slice(0, at) + alphabet[(alphabet.indexOf(s[at]!) + rng.int(1, 63)) % 64]! + s.slice(at + 1)
        expect(() => verifyDetached(pq ? message : v1Message, JSON.stringify(o), [pq ? FAKE_HYBRID_KEY : edKey])).toThrow(UpdateSignatureError)
      },
      fcRuns(10).numRuns,
    )
  })

  it('T-F1C-08: verifyDetached returns an id only from keys, and never with none pinned', () => {
    const pool: PinnedUpdateKey[] = [edKey, FAKE_HYBRID_KEY]
    const idOf = (k: PinnedUpdateKey) => (k.alg === 'ed25519' ? keyIdOf(k.publicKeyPem) : pinnedKeyId(k))
    forAll(
      'keys',
      (rng) => {
        const keys = pool.filter(() => rng.bool())
        const [msg, sig] = rng.bool() ? [message, goodPq] : [v1Message, goodV1]
        try {
          const id = verifyDetached(msg, rng.bool() ? sig : mutated(rng, sig), keys)
          expect(keys.map(idOf)).toContain(id)
        } catch (e) {
          expect(e).toBeInstanceOf(UpdateSignatureError)
        }
      },
      fcRuns(10).numRuns,
    )
    expect(() => verifyDetached(message, goodPq, [])).toThrow(UpdateSignatureError)
    expect(() => verifyDetached(v1Message, goodV1, [])).toThrow(UpdateSignatureError)
  })

  describe('versions', () => {
    const version = (rng: Rng): string =>
      rng.int(0, 9) === 0
        ? rng.pick(['', 'x', 'v', '1.2', 'latest', rng.string(10)])
        : `${rng.bool() ? 'v' : ''}${rng.int(0, 2)}.${rng.int(0, 2)}.${rng.int(0, 2)}${rng.pick(['', '', '-beta.1', '-rc', '+build'])}`

    it('T-F1C-09: isNewer is irreflexive, asymmetric and transitive', () => {
      forAll('isNewer', (rng) => {
        const [a, b, c] = [version(rng), version(rng), version(rng)]
        expect(isNewer(a, a)).toBe(false)
        expect(isNewer(a, b) && isNewer(b, a)).toBe(false)
        if (isNewer(a, b) && isNewer(b, c)) expect(isNewer(a, c)).toBe(true)
        else expect(isNewer(a, b) && isNewer(b, c) && !isNewer(a, c)).toBe(false)
      })
    })

    it('T-F1C-10: isNewer is false whenever either side does not parse', () => {
      forAll('unparsed', (rng) => {
        const [a, b] = [version(rng), version(rng)]
        if (parseVersion(a) === null || parseVersion(b) === null) expect(isNewer(a, b)).toBe(false)
        else expect(parseVersion(a)).toHaveLength(3)
      })
    })
  })

  it('T-F1C-11: pickInstaller returns an element of its input or null', () => {
    const urls = ['Slate-1.0.0-mac-arm64.dmg', 'Slate-1.0.0-mac-x64.DMG', 'Slate-1.0.0-linux-amd64.deb', 'Slate-1.0.0-linux-arm64.deb', 'Slate-1.0.0.zip', 'latest.yml', '.dmg', 'x_aarch64_.deb']
    forAll('pickInstaller', (rng) => {
      const files: UpdateFile[] = Array.from({ length: rng.int(0, 6) }, () => ({ url: rng.bool() ? rng.pick(urls) : rng.string(30), sha512: 'x', size: rng.int(0, 9) }))
      const kind = rng.pick(['dmg', 'deb', 'rpm', '', 'zip', 'appimage']) as InstallKind
      const arch = rng.bool() ? rng.pick(['arm64', 'x64', 'ia32', '', 'aarch64', 'x86_64', 'amd64', 'riscv', 'h)]픰', '(', '[', '.*', '\\']) : rng.string(8)
      const got = pickInstaller(files, kind, arch)
      if (got !== null) expect(files).toContain(got)
      else expect(got).toBeNull()
    })
  })
})
