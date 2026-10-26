// Signs a release offline: latest-*.yml and every artefact's SHA-512 get a detached `<file>.sig`
// that the app verifies before it offers, downloads or installs an update
// (packages/desktop/src/main/update/signature.ts builds the same messages; change both together).
//
// Usage: SLATE_UPDATE_SIGNING_KEY="<Ed25519 PKCS#8 PEM>" node scripts/sign-update.mjs <dir> [--pinned <file>]
// The key's public half must appear in the pinned-keys file (default: signature.ts), so a release
// is never signed with a key the shipped app would refuse.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const dir = args[0]
const pinIdx = args.indexOf('--pinned')
const pinnedFile = pinIdx >= 0 ? args[pinIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'desktop', 'src', 'main', 'update', 'signature.ts')

function fail(message) {
  console.error(`sign-update: ${message}`)
  process.exit(1)
}

if (!dir) fail('usage: sign-update.mjs <dir> [--pinned <file>]')
const pem = process.env.SLATE_UPDATE_SIGNING_KEY ?? ''
if (!pem.trim()) fail('SLATE_UPDATE_SIGNING_KEY is empty: a release is never published unsigned')

const privateKey = createPrivateKey(pem)
if (privateKey.asymmetricKeyType !== 'ed25519') fail(`the key is ${privateKey.asymmetricKeyType}, not ed25519`)
const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const keyId = createHash('sha256').update(spkiDer).digest('hex').slice(0, 16)
if (!readFileSync(pinnedFile, 'utf8').includes(spkiDer.toString('base64'))) fail(`public key ${keyId} is not pinned in ${pinnedFile}`)

const sigFile = (message) =>
  JSON.stringify({ format: 'slate-update-signature', version: 1, alg: 'ed25519', keyId, signature: sign(null, message, privateKey).toString('base64') }) + '\n'
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

for (const name of names) {
  const bytes = readFileSync(join(dir, name))
  const head = isFeed(name) ? `slate-update-manifest:v1\n${name}\n` : `slate-update-artifact:v1\n${name}\n${sha512(bytes)}\n`
  const message = isFeed(name) ? Buffer.concat([Buffer.from(head, 'utf8'), bytes]) : Buffer.from(head, 'utf8')
  writeFileSync(join(dir, `${name}.sig`), sigFile(message))
}
console.log(`signed ${names.length} files in ${dir} with key ${keyId}`)
