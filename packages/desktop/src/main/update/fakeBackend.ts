import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallKind } from '../../shared/api'
import { artifactMessage, keyIdOf, manifestMessage, type PinnedUpdateKey } from './signature'
import type { UpdateBackend } from './updateService'

export const FAKE_VERSION = '9.9.9'
/** E2E launches out/main/index.js directly, where app.getVersion() reports Electron's own version. */
export const FAKE_CURRENT_VERSION = '0.1.0'

/** Long enough for an e2e test to see the progress display. */
const pause = () => new Promise<void>((r) => setTimeout(r, 600))

/** SLATE_FAKE_UPDATE picks the install kind e2e tests exercise (`<kind>` or `<kind>-badsig`); any other kind means deb. */
export function fakeInstallKind(value: string): InstallKind {
  const kind = value.replace(/-badsig$/, '')
  return kind === 'dmg' || kind === 'auto' || kind === 'manual' ? kind : 'deb'
}

/**
 * For e2e (SLATE_FAKE_UPDATE): always offers 9.9.9 and "downloads" an empty file, never touching the
 * network. Its feed is signed with a key pair made here, whose public half is `keys`: the e2e run
 * verifies for real against it, and a `-badsig` value signs the feed with a key that is not pinned.
 */
export function fakeBackend(opts: { downloadsDir: string; copy: (text: string) => void; manifestName: string; badSignature?: boolean }): UpdateBackend & { keys: PinnedUpdateKey[] } {
  const files = ['mac-arm64.dmg', 'mac-x64.dmg', 'linux-amd64.deb', 'linux-arm64.deb'].map((s) => ({ url: `Slate-${FAKE_VERSION}-${s}`, sha512: 'ZmFrZQ==', size: 0 }))
  const pair = () => generateKeyPairSync('ed25519')
  const trusted = pair()
  const signer = opts.badSignature ? pair() : trusted
  const keyPem = (k: ReturnType<typeof pair>) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const sigFile = (m: Uint8Array) =>
    new TextEncoder().encode(
      JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId: keyIdOf(keyPem(signer)), signature: sign(null, m, signer.privateKey).toString('base64') }),
    )
  const feed = new TextEncoder().encode(`version: ${FAKE_VERSION}\nfiles:\n${files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: 0\n`).join('')}`)
  const assets = new Map<string, Uint8Array>([[opts.manifestName, feed], [`${opts.manifestName}.sig`, sigFile(manifestMessage(opts.manifestName, feed))]])
  for (const f of files) assets.set(`${f.url}.sig`, sigFile(artifactMessage(f.url, f.sha512)))
  return {
    keys: [{ alg: 'ed25519', publicKeyPem: keyPem(trusted) }],
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
