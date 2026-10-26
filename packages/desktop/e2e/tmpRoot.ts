import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'slate-e2e-run-'
/** No run lasts this long, so an older root belongs to a run that was killed before its teardown. */
const STALE_MS = 6 * 60 * 60 * 1000

/**
 * Every spec makes a data folder (and Slate its temp files) with `tmpdir()`, and none removed them:
 * thousands of runs filled the disk. One root per run, set before the workers start so they and the
 * apps they launch inherit it, is removed when the run ends. A run killed mid-way (a usage limit, a
 * timeout) never reaches its teardown, so each run also removes stale roots left by earlier ones.
 */
export default function globalSetup(): () => void {
  const base = tmpdir()
  removeStaleRoots(base, Date.now())
  const root = mkdtempSync(join(base, PREFIX))
  process.env.TMPDIR = root
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}

function removeStaleRoots(base: string, now: number): void {
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue
    const path = join(base, name)
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Another run removed it first.
    }
  }
}
