import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
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
