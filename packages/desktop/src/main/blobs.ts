import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BLOB_SCHEME = 'slate-blob'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}
const FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/

/** Content-addressed image files, served to the renderer as slate-blob://blob/<sha256>.<ext>. */
export class BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  put(bytes: Uint8Array, mime: string): string {
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${EXTENSIONS[mime] ?? 'bin'}`
    const file = join(this.dir, name)
    if (!existsSync(file)) {
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
    }
    return `${BLOB_SCHEME}://blob/${name}`
  }

  /** Stored file names (`<sha256>.<ext>`). */
  list(): string[] {
    return readdirSync(this.dir).filter((n) => FILE_NAME.test(n))
  }

  has(name: string): boolean {
    return FILE_NAME.test(name) && existsSync(join(this.dir, name))
  }

  read(name: string): Uint8Array {
    if (!FILE_NAME.test(name)) throw new Error(`Bad blob name: ${name}`)
    return new Uint8Array(readFileSync(join(this.dir, name)))
  }

  /** Stores bytes fetched under a known name, e.g. from another device. */
  write(name: string, bytes: Uint8Array): void {
    if (!FILE_NAME.test(name)) throw new Error(`Bad blob name: ${name}`)
    const file = join(this.dir, name)
    writeFileSync(`${file}.tmp`, bytes)
    renameSync(`${file}.tmp`, file)
  }

  pathForUrl(url: string): string | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== `${BLOB_SCHEME}:` || parsed.host !== 'blob') return null
    const name = parsed.pathname.slice(1)
    return FILE_NAME.test(name) ? join(this.dir, name) : null
  }
}
