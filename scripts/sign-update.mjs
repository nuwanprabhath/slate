// Signs a release offline: latest-*.yml and every artefact's SHA-512 get a detached `<file>.sig` (version 1,
// Ed25519, read by clients up to 0.3.x) and `<file>.pq.sig` (version 2, hybrid ml-dsa-65+ed25519), which the app
// verifies before it offers, downloads or installs an update
// (packages/desktop/src/main/update/signature.ts builds the same messages; change both together).
//
// Usage: SLATE_UPDATE_SIGNING_KEY="<Ed25519 PKCS#8 PEM>" SLATE_UPDATE_SIGNING_KEY_MLDSA="<ML-DSA-65 PKCS#8 PEM>" \
//          node scripts/sign-update.mjs <dir> [--pinned <file>]
// Needs a runtime that signs ML-DSA-65 (Node >= 24.7 on OpenSSL >= 3.5); it refuses to run anywhere else rather
// than publish a release without the post-quantum signature. Both public halves must be one hybrid key in the
// pinned-keys file (default: signature.ts), so a release is never signed with a key the shipped app would refuse.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HYBRID_ALG = 'ml-dsa-65+ed25519'
const MLDSA_CONTEXT = Buffer.from('slate-update', 'utf8')

const args = process.argv.slice(2)
const dir = args[0]
const pinIdx = args.indexOf('--pinned')
const pinnedFile = pinIdx >= 0 ? args[pinIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'desktop', 'src', 'main', 'update', 'signature.ts')

function fail(message) {
  console.error(`sign-update: ${message}`)
  process.exit(1)
}

if (!dir) fail('usage: sign-update.mjs <dir> [--pinned <file>]')

// A runtime that cannot sign ML-DSA-65, or ignores the FIPS 204 context, would make signatures the app refuses.
function mldsaWorks() {
  try {
    const probe = generateKeyPairSync('ml-dsa-65')
    const message = Buffer.from('slate-update probe', 'utf8')
    const sig = sign(null, message, { key: probe.privateKey, context: MLDSA_CONTEXT })
    return (
      verify(null, message, { key: probe.publicKey, context: MLDSA_CONTEXT }, sig) &&
      !verify(null, message, { key: probe.publicKey, context: Buffer.from('another context', 'utf8') }, sig)
    )
  } catch {
    return false
  }
}
if (!mldsaWorks()) fail(`this runtime (Node ${process.versions.node}, OpenSSL ${process.versions.openssl}) cannot sign ML-DSA-65 with a context; run the signer under Node >= 24.7 built against OpenSSL >= 3.5`)

function privateKeyFrom(variable, type) {
  const pem = process.env[variable] ?? ''
  if (!pem.trim()) fail(`${variable} is empty: a release is never published unsigned`)
  let key
  try {
    key = createPrivateKey(pem)
  } catch (err) {
    fail(`${variable} is not a private key this runtime reads: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (key.asymmetricKeyType !== type) fail(`${variable} is ${key.asymmetricKeyType}, not ${type}`)
  return key
}
const privateKey = privateKeyFrom('SLATE_UPDATE_SIGNING_KEY', 'ed25519')
const mldsaKey = privateKeyFrom('SLATE_UPDATE_SIGNING_KEY_MLDSA', 'ml-dsa-65')

const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const keyId = createHash('sha256').update(spkiDer).digest('hex').slice(0, 16)
const pinnedText = readFileSync(pinnedFile, 'utf8')
if (!pinnedText.includes(spkiDer.toString('base64'))) fail(`public key ${keyId} is not pinned in ${pinnedFile}`)

// The hybrid keys as signature.ts writes them: `ed25519Pem: '<PEM>',` then `mldsa65SpkiB64: '<base64>'`.
// The two halves must be one pinned key, not each pinned somewhere.
const mldsaSpkiDer = createPublicKey(mldsaKey).export({ type: 'spki', format: 'der' })
const hybridPinned = [...pinnedText.matchAll(/ed25519Pem:\s*(['"`])([^'"`]*)\1\s*,\s*mldsa65SpkiB64:\s*(['"`])([A-Za-z0-9+/=]+)\3/g)].some(
  ([, , edPem, , mldsaB64]) => edPem.includes(spkiDer.toString('base64')) && mldsaB64 === mldsaSpkiDer.toString('base64'),
)
const hybridKeyId = createHash('sha256').update(spkiDer).update(mldsaSpkiDer).digest('hex').slice(0, 16)
if (!hybridPinned) fail(`ML-DSA-65 public key of hybrid key ${hybridKeyId} is not pinned with Ed25519 key ${keyId} in ${pinnedFile}`)

const sigFile = (message) =>
  JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId, signature: sign(null, message, privateKey).toString('base64') }) + '\n'
// Each half signs M' = "slate-update/v2|ml-dsa-65+ed25519|" ‖ keyId ‖ "|" ‖ M (signature.ts hybridMessage).
const pqSigFile = (message) => {
  const bound = Buffer.concat([Buffer.from(`slate-update/v2|${HYBRID_ALG}|${hybridKeyId}|`, 'utf8'), message])
  const sig = { ed25519: sign(null, bound, privateKey).toString('base64'), mldsa65: sign(null, bound, { key: mldsaKey, context: MLDSA_CONTEXT }).toString('base64') }
  return JSON.stringify({ format: 'slate-update-signature', version: 2, alg: HYBRID_ALG, keyId: hybridKeyId, sig }) + '\n'
}
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64')

const names = readdirSync(dir).filter((n) => !n.endsWith('.sig') && statSync(join(dir, n)).isFile())
const isFeed = (n) => /^latest(-[a-z0-9]+)?\.yml$/.test(n)

// Every file a feed lists must be the file being signed: catch a stale or swapped artefact here.
for (const feed of names.filter(isFeed)) {
  const text = readFileSync(join(dir, feed), 'utf8')
  const entries = [...text.matchAll(/^\s*-\s+url:\s*['"]?([^'"\n]+?)['"]?\s*\n\s+sha512:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)]
  // A feed in another shape would otherwise skip the check silently.
  const urls = (text.match(/^\s*-?\s*url:/gm) ?? []).length
  if (entries.length === 0 || entries.length !== urls) fail(`${feed}: read ${entries.length} url/sha512 entries of ${urls} url lines`)
  for (const m of entries) {
    const [, url, listed] = m
    if (!names.includes(url)) fail(`${feed} lists ${url}, which is not in ${dir}`)
    if (sha512(readFileSync(join(dir, url))) !== listed) fail(`sha512 of ${url} does not match ${feed}`)
  }
}

// Sign everything before writing anything, so a failure leaves no half-signed release.
const outputs = names.flatMap((name) => {
  const bytes = readFileSync(join(dir, name))
  const head = isFeed(name) ? `slate-update-manifest:v1\n${name}\n` : `slate-update-artifact:v1\n${name}\n${sha512(bytes)}\n`
  const message = isFeed(name) ? Buffer.concat([Buffer.from(head, 'utf8'), bytes]) : Buffer.from(head, 'utf8')
  return [
    [`${name}.sig`, sigFile(message)],
    [`${name}.pq.sig`, pqSigFile(message)],
  ]
})
for (const [file, text] of outputs) writeFileSync(join(dir, file), text)
console.log(`signed ${names.length} files in ${dir} with key ${keyId} (.sig) and hybrid key ${hybridKeyId} (.pq.sig)`)
