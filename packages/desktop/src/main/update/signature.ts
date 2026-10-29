import { createHash, createPublicKey, verify } from 'node:crypto'
import { verifyMlDsa } from '../vault/native'

/**
 * Detached signatures over the update feed (`latest-*.yml`) and over each artefact's SHA-512, made by the
 * release workflow (scripts/sign-update.mjs). Both sides must build the same messages: change one, change both.
 * Version 1 (`<name>.sig`) is Ed25519 alone; version 2 (`<name>.pq.sig`) is the hybrid `ml-dsa-65+ed25519`.
 */

export const HYBRID_ALG = 'ml-dsa-65+ed25519'
export type UpdateSigAlg = 'ed25519' | typeof HYBRID_ALG

export interface Ed25519UpdateKey {
  alg: 'ed25519'
  /** SPKI PEM. */
  publicKeyPem: string
}

export interface HybridUpdateKey {
  alg: typeof HYBRID_ALG
  /** SPKI PEM of the classical half. */
  ed25519Pem: string
  /** DER SPKI of the ML-DSA-65 half, base64. */
  mldsa65SpkiB64: string
}

export type PinnedUpdateKey = Ed25519UpdateKey | HybridUpdateKey

/**
 * Every key the app accepts. The next key is pinned here before it signs anything, so a rotation
 * needs no emergency release: a feed signed by any listed key verifies.
 *
 * Since phase 14 (D-12) the maintainer's key is hybrid, and a hybrid pin means only `.pq.sig` counts
 * (INV-PQ-8). The C12 Ed25519-only entry is gone: under that rule nothing could reach it, and its
 * public key lives on as the hybrid key's classical half (sign-update.mjs looks for it in this file).
 */
export const PINNED_UPDATE_KEYS: readonly PinnedUpdateKey[] = [
  {
    alg: HYBRID_ALG,
    ed25519Pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA70VVxESJ9WwQlDz5/HTCWdyhiNLtEHvkul0LK7SfdXY=\n-----END PUBLIC KEY-----\n',
    mldsa65SpkiB64:
      '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',
  },
]

export class UpdateSignatureError extends Error {
  override name = 'UpdateSignatureError'
}

const SIG_FORMAT = 'slate-update-signature'
const SIG_VERSION = 1
const PQ_SIG_VERSION = 2
/** A v1 signature file is a few hundred bytes; anything bigger is not one. */
const MAX_SIG_BYTES = 4096
/** A v2 file carries a 3309-byte ML-DSA-65 signature in base64 (4412 characters). */
const MAX_PQ_SIG_BYTES = 16 * 1024
const ED25519_SIG_BYTES = 64
const MLDSA65_SIG_BYTES = 3309
/** FIPS 204 context string of every ML-DSA update signature. */
const MLDSA_CONTEXT = 'slate-update'

/** First 16 hex digits of SHA-256 over the DER SPKI: names the key without carrying it. */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** A hybrid key's id covers both halves: SHA-256 over DER(Ed25519 SPKI) ‖ DER(ML-DSA SPKI). */
export function pinnedKeyId(pinned: PinnedUpdateKey): string {
  if (pinned.alg === 'ed25519') return keyIdOf(pinned.publicKeyPem)
  const ed = createPublicKey(pinned.ed25519Pem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(ed).update(Buffer.from(pinned.mldsa65SpkiB64, 'base64')).digest('hex').slice(0, 16)
}

/** INV-PQ-8: once any pinned key is hybrid, only `.pq.sig` files count and `.sig` is never read. */
export function requiresPq(keys: readonly PinnedUpdateKey[]): boolean {
  return keys.some((k) => k.alg === HYBRID_ALG)
}

/** The signature file the verifier fetches for `name` under `keys`. */
export function signatureName(name: string, keys: readonly PinnedUpdateKey[]): string {
  return requiresPq(keys) ? `${name}.pq.sig` : `${name}.sig`
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

/**
 * M' = "slate-update/v2|ml-dsa-65+ed25519|" ‖ keyId ‖ "|" ‖ M, what each hybrid half signs: binding the pair and the
 * key id stops a half being stripped into a v1 signature or moved to another key.
 */
export function hybridMessage(keyId: string, message: Uint8Array): Uint8Array {
  const head = utf8(`slate-update/v2|${HYBRID_ALG}|${keyId}|`)
  const out = new Uint8Array(head.length + message.length)
  out.set(head, 0)
  out.set(message, head.length)
  return out
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

export interface PqSignatureFile {
  keyId: string
  ed25519: Uint8Array
  mldsa65: Uint8Array
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

function sigBytes(value: unknown, label: string, length: number): Uint8Array {
  if (typeof value !== 'string' || !B64.test(value)) throw new UpdateSignatureError(`${label} signature is not base64`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length) throw new UpdateSignatureError(`${label} signature is ${bytes.length} bytes, not ${length}`)
  return bytes
}

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A version 2 file, strictly: its size, exactly its keys and each signature's length, before any verify call. */
export function parsePqSignatureFile(text: string): PqSignatureFile {
  if (text.length > MAX_PQ_SIG_BYTES) throw new UpdateSignatureError('post-quantum signature file is too large')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new UpdateSignatureError('post-quantum signature file is not JSON')
  }
  if (!isObject(raw)) throw new UpdateSignatureError('post-quantum signature file is not an object')
  if (raw.format !== SIG_FORMAT) throw new UpdateSignatureError('post-quantum signature file has the wrong format')
  if (raw.version !== PQ_SIG_VERSION) throw new UpdateSignatureError(`post-quantum signature missing (got a version ${String(raw.version)} signature file)`)
  if (!exactKeys(raw, ['format', 'version', 'alg', 'keyId', 'sig'])) throw new UpdateSignatureError('post-quantum signature file has unknown or missing keys')
  if (raw.alg !== HYBRID_ALG) throw new UpdateSignatureError(`signature algorithm ${String(raw.alg)} is not supported`)
  if (typeof raw.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(raw.keyId)) throw new UpdateSignatureError('post-quantum signature file has a malformed keyId')
  const sig = raw.sig
  if (!isObject(sig) || !exactKeys(sig, ['ed25519', 'mldsa65'])) throw new UpdateSignatureError('post-quantum signature file needs exactly the ed25519 and mldsa65 signatures')
  return { keyId: raw.keyId, ed25519: sigBytes(sig.ed25519, 'Ed25519', ED25519_SIG_BYTES), mldsa65: sigBytes(sig.mldsa65, 'ML-DSA-65', MLDSA65_SIG_BYTES) }
}

function verifyV1(message: Uint8Array, sigText: string, keys: readonly Ed25519UpdateKey[]): string {
  const sig = parseSignatureFile(sigText)
  if (sig.alg !== 'ed25519') throw new UpdateSignatureError(`signature algorithm ${sig.alg} is not supported`)
  const key = keys.find((k) => keyIdOf(k.publicKeyPem) === sig.keyId)
  if (!key) throw new UpdateSignatureError(`signing key ${sig.keyId} is not pinned`)
  const bytes = Buffer.from(sig.signature, 'base64')
  if (bytes.length !== ED25519_SIG_BYTES || !verify(null, message, createPublicKey(key.publicKeyPem), bytes)) throw new UpdateSignatureError(`signature by ${sig.keyId} does not verify`)
  return sig.keyId
}

/** Both halves must verify over M'; neither alone is enough. */
function verifyHybrid(message: Uint8Array, sigText: string, keys: readonly HybridUpdateKey[]): string {
  const sig = parsePqSignatureFile(sigText)
  const key = keys.find((k) => pinnedKeyId(k) === sig.keyId)
  if (!key) throw new UpdateSignatureError(`signing key ${sig.keyId} is not pinned`)
  const bound = hybridMessage(sig.keyId, message)
  if (!verify(null, bound, createPublicKey(key.ed25519Pem), sig.ed25519)) throw new UpdateSignatureError(`Ed25519 half of the signature by ${sig.keyId} does not verify`)
  let ok = false
  try {
    ok = verifyMlDsa(65, Buffer.from(key.mldsa65SpkiB64, 'base64'), bound, utf8(MLDSA_CONTEXT), sig.mldsa65)
  } catch {
    ok = false
  }
  if (!ok) throw new UpdateSignatureError(`ML-DSA-65 half of the signature by ${sig.keyId} does not verify`)
  return sig.keyId
}

/**
 * Returns the id of the key that verified, or throws UpdateSignatureError. With a hybrid key pinned, `sigText`
 * must be a version 2 file and only hybrid keys count (INV-PQ-8); otherwise it is a version 1 Ed25519 file.
 */
export function verifyDetached(message: Uint8Array, sigText: string, keys: readonly PinnedUpdateKey[]): string {
  if (requiresPq(keys)) return verifyHybrid(message, sigText, keys.filter((k): k is HybridUpdateKey => k.alg === HYBRID_ALG))
  return verifyV1(message, sigText, keys.filter((k): k is Ed25519UpdateKey => k.alg === 'ed25519'))
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
