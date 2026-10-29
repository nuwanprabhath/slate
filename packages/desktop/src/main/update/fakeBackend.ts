import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallKind } from '../../shared/api'
import { FAKE_ED25519_PEM, FAKE_ED25519_PKCS8_B64, FAKE_MLDSA65_SIGS, FAKE_MLDSA65_SPKI_B64 } from './fakeHybridKey'
import { artifactMessage, HYBRID_ALG, hybridMessage, manifestMessage, pinnedKeyId, type HybridUpdateKey, type PinnedUpdateKey } from './signature'
import type { UpdateBackend } from './updateService'

export const FAKE_VERSION = '9.9.9'
/** E2E launches out/main/index.js directly, where app.getVersion() reports Electron's own version. */
export const FAKE_CURRENT_VERSION = '0.1.0'

/** Long enough for an e2e test to see the progress display. */
const pause = () => new Promise<void>((r) => setTimeout(r, 600))

/**
 * How the fake feed is signed, from SLATE_FAKE_UPDATE's suffix: `<kind>` signs it with the pinned hybrid test key,
 * `-badsig` with a key that is not pinned, `-nomldsa` with the ML-DSA half stripped.
 */
export type FakeSignature = 'good' | 'unpinned' | 'stripped'
const SUFFIX = /-(badsig|nomldsa)$/

/** SLATE_FAKE_UPDATE picks the install kind e2e tests exercise (`<kind>`, `<kind>-badsig` or `<kind>-nomldsa`); any other kind means deb. */
export function fakeInstallKind(value: string): InstallKind {
  const kind = value.replace(SUFFIX, '')
  return kind === 'dmg' || kind === 'auto' || kind === 'manual' ? kind : 'deb'
}

export function fakeSignature(value: string): FakeSignature {
  const m = SUFFIX.exec(value)
  return m?.[1] === 'badsig' ? 'unpinned' : m?.[1] === 'nomldsa' ? 'stripped' : 'good'
}

/** The test-only hybrid key (fakeHybridKey.ts), trusted only in a fake-feed run. */
export const FAKE_HYBRID_KEY: HybridUpdateKey = { alg: HYBRID_ALG, ed25519Pem: FAKE_ED25519_PEM, mldsa65SpkiB64: FAKE_MLDSA65_SPKI_B64 }

export const FAKE_FILES = ['mac-arm64.dmg', 'mac-x64.dmg', 'linux-amd64.deb', 'linux-arm64.deb'].map((s) => ({ url: `Slate-${FAKE_VERSION}-${s}`, sha512: 'ZmFrZQ==', size: 0 }))

/** The fake feed's bytes; the precomputed ML-DSA signatures cover exactly these. */
export function fakeFeed(): Uint8Array {
  return new TextEncoder().encode(`version: ${FAKE_VERSION}\nfiles:\n${FAKE_FILES.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: 0\n`).join('')}`)
}

/** Ed25519 by the test key's classical half, base64. */
export function fakeEd25519Sign(message: Uint8Array): string {
  return sign(null, message, { key: Buffer.from(FAKE_ED25519_PKCS8_B64, 'base64'), format: 'der', type: 'pkcs8' }).toString('base64')
}

/** A version 2 (`.pq.sig`) file; a half left out is left out of `sig`, as a stripping attacker would. */
export function pqSigFile(keyId: string, sig: { ed25519?: string; mldsa65?: string }): string {
  return JSON.stringify({ format: 'slate-update-signature', version: 2, alg: HYBRID_ALG, keyId, sig })
}

/**
 * For e2e (SLATE_FAKE_UPDATE): always offers 9.9.9 and "downloads" an empty file, never touching the
 * network. Its feed carries `.pq.sig` files by the test hybrid key, whose public half is `keys`: the e2e run
 * verifies for real against it (ML-DSA in the module), the way a production build verifies against its pin.
 */
export function fakeBackend(opts: { downloadsDir: string; copy: (text: string) => void; manifestName: string; signature?: FakeSignature }): UpdateBackend & { keys: PinnedUpdateKey[] } {
  const mode = opts.signature ?? 'good'
  const files = FAKE_FILES
  const ed25519Pem = mode === 'unpinned' ? generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() : FAKE_ED25519_PEM
  const keyId = pinnedKeyId({ ...FAKE_HYBRID_KEY, ed25519Pem })
  const sigFile = (name: string, m: Uint8Array) => {
    const mldsa65 = FAKE_MLDSA65_SIGS[name]
    const halves = { ed25519: fakeEd25519Sign(hybridMessage(keyId, m)), ...(mode === 'stripped' || !mldsa65 ? {} : { mldsa65 }) }
    return new TextEncoder().encode(pqSigFile(keyId, halves))
  }
  const feed = fakeFeed()
  const assets = new Map<string, Uint8Array>([[opts.manifestName, feed], [`${opts.manifestName}.pq.sig`, sigFile(opts.manifestName, manifestMessage(opts.manifestName, feed))]])
  for (const f of files) assets.set(`${f.url}.pq.sig`, sigFile(f.url, artifactMessage(f.url, f.sha512)))
  return {
    keys: [FAKE_HYBRID_KEY],
    fetchAsset: async (_version, name) => assets.get(name) ?? null,
    check: async () => ({ version: FAKE_VERSION, files }),
    downloadAuto: async (_expected, onProgress) => {
      onProgress(50)
      await pause()
      onProgress(100)
    },
    installAuto: () => {},
    async downloadFile(file, _version, onProgress) {
      const path = join(opts.downloadsDir, file.url)
      writeFileSync(path, '')
      onProgress(50)
      await pause()
      onProgress(100)
      return path
    },
    openPath: async () => {},
    showInFolder: () => {},
    openExternal: () => {},
    copy: opts.copy,
  }
}
