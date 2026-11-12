// The committed regression corpus: packages/<pkg>/test/corpus/<target>/<first 16 hex of sha256>.<ext>.
// Every file is replayed as its own test case, so a past crash stays a unit test for good.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The corpus files of one target, sorted by name; none when the folder does not exist yet. */
export function corpusEntries(pkg: string, target: string): Array<{ name: string; bytes: Uint8Array }> {
  const dir = join(PACKAGES, pkg, 'test', 'corpus', target)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) }))
}

/** Registers one it() per corpus file, in a loop, so each past crash is its own test case. */
export function replayCorpus(pkg: string, target: string, run: (bytes: Uint8Array, name: string) => void | Promise<void>): void {
  for (const { name, bytes } of corpusEntries(pkg, target)) it(`corpus ${pkg}/${target}/${name}`, () => run(bytes, name))
}
