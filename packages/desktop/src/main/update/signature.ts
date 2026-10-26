import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * Detached signatures over the update feed (`latest-*.yml.sig`) and over each artefact's SHA-512
 * (`<artefact>.sig`), made by the release workflow (scripts/sign-update.mjs) with the key in the
 * `SLATE_UPDATE_SIGNING_KEY` secret. Both sides must build the same messages: change one, change both.
 */

/** Ed25519 today. The hybrid `ml-dsa-65+ed25519` (CNSA 2.0) gets its own value when the signer supports FIPS 204. */
export type UpdateSigAlg = 'ed25519'

export interface PinnedUpdateKey {
  alg: UpdateSigAlg
  /** SPKI PEM. */
  publicKeyPem: string
}

/**
 * Every key the app accepts. The next key is pinned here before it signs anything, so a rotation
 * needs no emergency release: a feed signed by any listed key verifies.
 */
export const PINNED_UPDATE_KEYS: readonly PinnedUpdateKey[] = [
  {
    alg: 'ed25519',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA70VVxESJ9WwQlDz5/HTCWdyhiNLtEHvkul0LK7SfdXY=\n-----END PUBLIC KEY-----\n',
  },
]

export class UpdateSignatureError extends Error {
  override name = 'UpdateSignatureError'
}

const SIG_FORMAT = 'slate-update-signature'
const SIG_VERSION = 1
/** A signature file is a few hundred bytes; anything bigger is not one. */
const MAX_SIG_BYTES = 4096

/** First 16 hex digits of SHA-256 over the DER SPKI: names the key without carrying it. */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** The feed file's own bytes, prefixed so a feed signature can never pass as an artefact one. */
export function manifestMessage(name: string, bytes: Uint8Array): Uint8Array {
  const head = utf8(`slate-update-manifest:v1\n${name}\n`)
  const out = new Uint8Array(head.length + bytes.length)
  out.set(head, 0)
  out.set(bytes, head.length)
  return out
}

/** `sha512` is base64, as electron-builder writes it in latest-*.yml. */
export function artifactMessage(name: string, sha512: string): Uint8Array {
  return utf8(`slate-update-artifact:v1\n${name}\n${sha512}\n`)
}

export interface SignatureFile {
  alg: string
  keyId: string
  signature: string
}

export function parseSignatureFile(text: string): SignatureFile {
  if (text.length > MAX_SIG_BYTES) throw new UpdateSignatureError('signature file is too large')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new UpdateSignatureError('signature file is not JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateSignatureError('signature file is not an object')
  const o = raw as Record<string, unknown>
  if (o.format !== SIG_FORMAT) throw new UpdateSignatureError('signature file has the wrong format')
  if (o.version !== SIG_VERSION) throw new UpdateSignatureError(`signature file version ${String(o.version)} is not supported`)
  const { alg, keyId, signature } = o
  if (typeof alg !== 'string' || typeof keyId !== 'string' || typeof signature !== 'string') throw new UpdateSignatureError('signature file is missing alg, keyId or signature')
  return { alg, keyId, signature }
}

/** Returns the id of the key that verified, or throws UpdateSignatureError. */
export function verifyDetached(message: Uint8Array, sigText: string, keys: readonly PinnedUpdateKey[]): string {
  const sig = parseSignatureFile(sigText)
  if (sig.alg !== 'ed25519') throw new UpdateSignatureError(`signature algorithm ${sig.alg} is not supported`)
  const key = keys.find((k) => k.alg === sig.alg && keyIdOf(k.publicKeyPem) === sig.keyId)
  if (!key) throw new UpdateSignatureError(`signing key ${sig.keyId} is not pinned`)
  const bytes = Buffer.from(sig.signature, 'base64')
  if (bytes.length !== 64 || !verify(null, message, createPublicKey(key.publicKeyPem), bytes)) throw new UpdateSignatureError(`signature by ${sig.keyId} does not verify`)
  return sig.keyId
}

export interface Manifest {
  version: string
  files: Array<{ url: string; sha512: string }>
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * The subset of YAML electron-builder writes in latest-*.yml: a top-level `version`, and a `files`
 * list of `url` / `sha512` / `size` entries. Read only after the bytes verified.
 */
export function parseManifest(text: string): Manifest {
  let version = ''
  const files: Manifest['files'] = []
  let inFiles = false
  let cur: { url?: string; sha512?: string } | null = null
  const flush = () => {
    if (cur?.url && cur.sha512) files.push({ url: cur.url, sha512: cur.sha512 })
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (top) {
      flush()
      inFiles = top[1] === 'files'
      if (top[1] === 'version') version = unquote(top[2]!)
      continue
    }
    if (!inFiles) continue
    const item = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    const field = item ?? /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!field) continue
    if (item) flush()
    cur ??= {}
    if (field[1] === 'url') cur.url = unquote(field[2]!)
    if (field[1] === 'sha512') cur.sha512 = unquote(field[2]!)
  }
  flush()
  return { version, files }
}
