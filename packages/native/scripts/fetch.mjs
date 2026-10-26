// Downloads and unpacks the pinned third-party sources (OpenSSL, the FIPS provider, SQLCipher).
// Every tarball must hash to its pin in deps.lock.json before anything reads it.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BUILD_DIR, parsePublishedSha256, verifyTarball } from './lib.mjs'

/** fetch with a few retries: GitHub's release CDN drops the odd connection. */
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
      return res
    } catch (e) {
      if (attempt === 4) throw e
      console.warn(`${e.message ?? e}; retrying (${attempt}/3)`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

/**
 * Downloads (once) and verifies a pinned tarball. Where the upstream publishes a .sha256 (OpenSSL),
 * the pin is also compared with it; SQLCipher publishes none, so its pin in deps.lock.json is the control.
 */
export async function fetchPinned(dep, { offline = false } = {}) {
  const dir = join(BUILD_DIR, 'downloads')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, dep.file ?? basename(new URL(dep.url).pathname))
  if (!offline && dep.sha256Url) {
    const published = parsePublishedSha256(await (await get(dep.sha256Url)).text())
    if (published !== dep.sha256) throw new Error(`${dep.sha256Url} says ${published}, deps.lock.json pins ${dep.sha256}; refusing`)
  }
  if (!existsSync(file)) {
    if (offline) throw new Error(`${file} is missing and --offline was given`)
    const res = await get(dep.url)
    writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()))
    try {
      verifyTarball(file + '.part', dep.sha256)
    } catch (e) {
      rmSync(file + '.part', { force: true })
      throw e
    }
    copyFileSync(file + '.part', file)
    rmSync(file + '.part')
  }
  verifyTarball(file, dep.sha256)
  console.log(`verified ${basename(file)} sha256=${dep.sha256}`)
  return file
}

export function extractTarball(tarball, into, run) {
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', into, '--strip-components=1'], into)
}
