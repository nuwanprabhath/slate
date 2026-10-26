import { newId } from '@slate/core'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** tmp + fsync + rename + fsync(dir): after a crash the file is the old value or the new, never half. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${newId().slice(0, 13)}.tmp`)
  const fh = await open(tmp, 'wx', 0o600)
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
    await fh.sync()
  } catch (e) {
    await fh.close()
    await unlink(tmp).catch(() => {})
    throw e
  }
  await fh.close()
  await rename(tmp, path)
  // Windows cannot open a directory for fsync; NTFS journals the rename.
  if (process.platform !== 'win32') {
    const d = await open(dir, 'r')
    try {
      await d.sync()
    } finally {
      await d.close()
    }
  }
}

/** Every local vault JSON is a few hundred bytes; remote headers are capped at the same 64 KiB. */
export const LOCAL_JSON_CAP = 64 * 1024

/** A local JSON file over its cap: refused before it is read whole or parsed (audit F-GEN-02). */
export class JsonTooLarge extends Error {
  override name = 'JsonTooLarge'
  constructor(path: string, cap: number, why: 'too large' | 'not a file' = 'too large') {
    super(why === 'not a file' ? `${basename(path)} is not a regular file` : `${basename(path)} is larger than ${String(cap)} bytes`)
  }
}

/**
 * The only way vault code reads a local JSON file. A local writer can make a file of any size, so
 * at most `cap + 1` bytes are ever read (the size can change between a stat and the read), and an
 * oversized file, or anything that is not a regular file, throws `JsonTooLarge` before
 * `JSON.parse` sees it.
 */
export async function readJsonCapped(path: string, cap: number = LOCAL_JSON_CAP): Promise<unknown> {
  // Non-blocking, so a FIFO planted under a vault name cannot hang the open; then regular files only.
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await fh.stat()).isFile()) throw new JsonTooLarge(path, cap, 'not a file')
    const buf = Buffer.alloc(cap + 1)
    let n = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
      if (n > cap) throw new JsonTooLarge(path, cap)
    }
    return JSON.parse(buf.toString('utf8', 0, n)) as unknown
  } finally {
    await fh.close()
  }
}

/**
 * `readJsonCapped` for synchronous callers (db/migrateToEncrypted.ts). Opened non-blocking and
 * refused unless it is a regular file, so a FIFO planted under a vault name cannot hang the caller.
 */
export function readJsonCappedSync(path: string, cap: number = LOCAL_JSON_CAP): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new JsonTooLarge(path, cap, 'not a file')
    const buf = Buffer.alloc(cap + 1)
    let n = 0
    for (;;) {
      const bytesRead = readSync(fd, buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
      if (n > cap) throw new JsonTooLarge(path, cap)
    }
    return JSON.parse(buf.toString('utf8', 0, n)) as unknown
  } finally {
    closeSync(fd)
  }
}
