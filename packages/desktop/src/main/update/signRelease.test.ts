import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactMessage, manifestMessage, verifyDetached, type PinnedUpdateKey } from './signature'

// The release workflow's signer (scripts/sign-update.mjs) and the app's verifier must agree byte for byte.
const SCRIPT = join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'sign-update.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function release() {
  const dir = mkdtempSync(join(tmpdir(), 'slate-sign-'))
  dirs.push(dir)
  const deb = Buffer.from('deb bytes')
  const sha = createHash('sha512').update(deb).digest('base64')
  writeFileSync(join(dir, 'Slate-0.2.0-linux-amd64.deb'), deb)
  writeFileSync(join(dir, 'latest-linux.yml'), `version: 0.2.0\nfiles:\n  - url: Slate-0.2.0-linux-amd64.deb\n    sha512: ${sha}\n    size: ${deb.length}\n`)
  writeFileSync(join(dir, 'slate-sbom.cdx.json'), '{"bomFormat":"CycloneDX"}')
  return { dir, sha }
}

function run(dir: string, privatePem: string, pinned: string) {
  const pinnedFile = join(dir, '..', `${dir.split('/').pop()}-pinned.ts`)
  writeFileSync(pinnedFile, pinned)
  dirs.push(pinnedFile)
  return spawnSync(process.execPath, [SCRIPT, dir, '--pinned', pinnedFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLATE_UPDATE_SIGNING_KEY: privatePem },
    encoding: 'utf8',
  })
}

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const key: PinnedUpdateKey = { alg: 'ed25519', publicKeyPem: publicPem }
  return { key, publicPem, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

describe('scripts/sign-update.mjs', () => {
  it('writes .sig files the app verifies: the feed, each artefact and the SBOM', () => {
    const { dir, sha } = release()
    const k = keys()
    const out = run(dir, k.privatePem, k.publicPem)
    expect(out.status, out.stderr).toBe(0)
    const feed = readFileSync(join(dir, 'latest-linux.yml'))
    expect(() => verifyDetached(manifestMessage('latest-linux.yml', feed), readFileSync(join(dir, 'latest-linux.yml.sig'), 'utf8'), [k.key])).not.toThrow()
    const debSig = readFileSync(join(dir, 'Slate-0.2.0-linux-amd64.deb.sig'), 'utf8')
    expect(JSON.parse(debSig)).toMatchObject({ alg: 'ed25519' })
    expect(() => verifyDetached(artifactMessage('Slate-0.2.0-linux-amd64.deb', sha), debSig, [k.key])).not.toThrow()
    const sbom = readFileSync(join(dir, 'slate-sbom.cdx.json'))
    const sbomSha = createHash('sha512').update(sbom).digest('base64')
    expect(() => verifyDetached(artifactMessage('slate-sbom.cdx.json', sbomSha), readFileSync(join(dir, 'slate-sbom.cdx.json.sig'), 'utf8'), [k.key])).not.toThrow()
  })

  it('refuses without a key, with a key the app does not pin, and when a file does not match its feed', () => {
    const k = keys()
    const a = release()
    expect(run(a.dir, '', k.publicPem).status).not.toBe(0)
    const b = release()
    const unpinned = run(b.dir, k.privatePem, keys().publicPem)
    expect(unpinned.status).not.toBe(0)
    expect(unpinned.stderr).toMatch(/not pinned/)
    const c = release()
    writeFileSync(join(c.dir, 'Slate-0.2.0-linux-amd64.deb'), 'tampered')
    const mismatch = run(c.dir, k.privatePem, k.publicPem)
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toMatch(/sha512/)
  })
  it('review F5: refuses a feed whose entries it cannot read, instead of skipping the check', () => {
    const k = keys()
    const a = release()
    const feed = join(a.dir, 'latest-linux.yml')
    // Same data, keys in another order: the url/sha512 pairing no longer matches.
    writeFileSync(feed, `version: 0.2.0\nfiles:\n  - sha512: ${a.sha}\n    url: Slate-0.2.0-linux-amd64.deb\n    size: 9\n`)
    const out = run(a.dir, k.privatePem, k.publicPem)
    expect(out.status).not.toBe(0)
    expect(out.stderr).toMatch(/entries/)
    const b = release()
    writeFileSync(join(b.dir, 'latest-linux.yml'), 'version: 0.2.0\nfiles: []\n')
    expect(run(b.dir, k.privatePem, k.publicPem).status).not.toBe(0)
  })
})
