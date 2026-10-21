import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'slate.lock'

/** Marks the data folder as in use by this process; the returned function removes the mark. */
export function acquireLock(dir: string): () => void {
  const file = join(dir, LOCK_FILE)
  writeFileSync(file, String(process.pid))
  return () => {
    // A newer process may have overwritten it; only remove our own.
    if (readPid(file) === process.pid) rmSync(file, { force: true })
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** The pid of a live process holding the lock, ignoring `self`. A stale file (dead pid) is no holder. */
export function runningHolder(dir: string, self: number = process.pid): number | null {
  const pid = readPid(join(dir, LOCK_FILE))
  if (pid === null || pid === self) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}
