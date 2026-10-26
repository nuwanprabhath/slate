import { posix } from 'node:path'
import type { UpdateFile } from './pickInstaller'
import { artifactMessage, manifestMessage, parseManifest, UpdateSignatureError, verifyDetached, type PinnedUpdateKey } from './signature'
import type { FoundUpdate } from './updateService'
import { isNewer } from './versions'

declare const verifiedBrand: unique symbol

/**
 * A release whose feed verified under a pinned key. Only `release()` makes one, and every download
 * and install takes one, so an unverified release cannot reach them (there is no "tolerated" kind:
 * every build with this code requires a signature on every update, in every profile).
 */
export type VerifiedRelease = Readonly<FoundUpdate> & { readonly [verifiedBrand]: true }

export interface UpdateVerifier {
  /** Rejects with UpdateSignatureError unless the release is signed, bound to `found` and newer than the running version. */
  release(found: FoundUpdate): Promise<VerifiedRelease>
  /** Rejects unless `file`'s SHA-512 carries a pinned signature. */
  artifact(release: VerifiedRelease, file: UpdateFile): Promise<void>
}

export interface UpdateVerifierDeps {
  keys: readonly PinnedUpdateKey[]
  /** latest-mac.yml or latest-linux.yml: the feed electron-updater read. */
  manifestName: string
  /** The running version: anything not strictly newer is a rollback and refused. */
  currentVersion: string
  /** A release asset's bytes, or null when the release has no such file. */
  fetchAsset(version: string, name: string): Promise<Uint8Array | null>
}

const text = (b: Uint8Array) => new TextDecoder().decode(b)
const nameOf = (url: string) => posix.basename(url.replace(/[?#].*$/, ''))

/**
 * True only when `info` (electron-updater's cached update) is exactly the verified release: same
 * version and the same set of file names with the same SHA-512. Checked right before electron-updater
 * downloads or installs, since any later check replaces what it cached.
 */
export function sameRelease(info: { version: string; files: ReadonlyArray<{ url: string; sha512: string }> } | null | undefined, verified: VerifiedRelease): boolean {
  if (!info || info.version !== verified.version || info.files.length !== verified.files.length) return false
  const want = new Map(verified.files.map((f) => [nameOf(f.url), f.sha512]))
  return info.files.every((f) => want.get(nameOf(f.url)) === f.sha512)
}

export function createUpdateVerifier(deps: UpdateVerifierDeps): UpdateVerifier {
  return {
    async release(found) {
      if (!isNewer(found.version, deps.currentVersion)) throw new UpdateSignatureError(`release ${found.version} is not newer than ${deps.currentVersion}`)
      const name = deps.manifestName
      const bytes = await deps.fetchAsset(found.version, name)
      if (!bytes) throw new UpdateSignatureError(`release ${found.version} has no ${name}`)
      const sig = await deps.fetchAsset(found.version, `${name}.sig`)
      if (!sig) throw new UpdateSignatureError(`${name} of ${found.version} is unsigned`)
      verifyDetached(manifestMessage(name, bytes), text(sig), deps.keys)
      // electron-updater parsed its own copy of the feed; bind what it will act on to the bytes that verified.
      const signed = parseManifest(text(bytes))
      if (signed.version !== found.version) throw new UpdateSignatureError(`signed ${name} is for version ${signed.version}, not ${found.version}`)
      for (const f of found.files) {
        const entry = signed.files.find((s) => nameOf(s.url) === nameOf(f.url))
        if (!entry || entry.sha512 !== f.sha512) throw new UpdateSignatureError(`sha512 of ${nameOf(f.url)} is not the one in the signed ${name}`)
      }
      const copy = { version: found.version, files: found.files.map((f) => Object.freeze({ ...f })) }
      return Object.freeze(copy) as unknown as VerifiedRelease
    },

    async artifact(release, file) {
      const name = nameOf(file.url)
      if (!release.files.some((f) => nameOf(f.url) === name && f.sha512 === file.sha512)) throw new UpdateSignatureError(`${name} is not a file of the verified release`)
      const sig = await deps.fetchAsset(release.version, `${name}.sig`)
      if (!sig) throw new UpdateSignatureError(`signature of ${name} is missing`)
      verifyDetached(artifactMessage(name, file.sha512), text(sig), deps.keys)
    },
  }
}
