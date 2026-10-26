import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './db/openDatabase'

export const BLOB_SCHEME = 'slate-blob'

/** Larger images are refused when added; the same cap bounds what sync will download (§5.5). */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}
const MIMES: Record<string, string> = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]))
const FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/

export class ImageTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`This image is ${Math.ceil(bytes / 1024 / 1024)} MB; Slate stores images up to 64 MB.`)
    this.name = 'ImageTooLarge'
  }
}

/** Content-addressed images (`<sha256>.<ext>`), served to the renderer as slate-blob://blob/<name>. */
export interface BlobStore {
  /** Throws `ImageTooLarge` over `MAX_IMAGE_BYTES`. Returns the image's URL. */
  put(bytes: Uint8Array, mime: string): string
  list(): string[]
  has(name: string): boolean
  read(name: string): Uint8Array
  /** Stores bytes fetched under a known name, e.g. from another device. */
  write(name: string, bytes: Uint8Array): void
  readForUrl(url: string): { bytes: Uint8Array; mime: string } | null
}

/** The stored name a slate-blob:// URL points at, or null for anything else. */
export function blobNameFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${BLOB_SCHEME}:` || parsed.host !== 'blob') return null
  const name = parsed.pathname.slice(1)
  return FILE_NAME.test(name) ? name : null
}

function nameFor(bytes: Uint8Array, mime: string): string {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLarge(bytes.byteLength)
  return `${createHash('sha256').update(bytes).digest('hex')}.${EXTENSIONS[mime] ?? 'bin'}`
}

function checkName(name: string): void {
  if (!FILE_NAME.test(name)) throw new Error(`Bad blob name: ${name}`)
}

function mimeOf(name: string): string {
  return MIMES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}

/** Image files in a folder: plaintext users. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  put(bytes: Uint8Array, mime: string): string {
    const name = nameFor(bytes, mime)
    if (!existsSync(join(this.dir, name))) this.write(name, bytes)
    return `${BLOB_SCHEME}://blob/${name}`
  }

  list(): string[] {
    return readdirSync(this.dir).filter((n) => FILE_NAME.test(n))
  }

  has(name: string): boolean {
    return FILE_NAME.test(name) && existsSync(join(this.dir, name))
  }

  read(name: string): Uint8Array {
    checkName(name)
    return new Uint8Array(readFileSync(join(this.dir, name)))
  }

  write(name: string, bytes: Uint8Array): void {
    checkName(name)
    const file = join(this.dir, name)
    writeFileSync(`${file}.tmp`, bytes)
    renameSync(`${file}.tmp`, file)
  }

  readForUrl(url: string): { bytes: Uint8Array; mime: string } | null {
    const name = blobNameFromUrl(url)
    return name && this.has(name) ? { bytes: this.read(name), mime: mimeOf(name) } : null
  }
}

export const BLOB_DATA_TABLE = 'CREATE TABLE IF NOT EXISTS blob_data (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL)'

/** Images inside the (encrypted) notes database, so no image ever sits on disk in the clear. */
export class DbBlobStore implements BlobStore {
  constructor(private readonly db: Database.Database) {
    db.exec(BLOB_DATA_TABLE)
  }

  put(bytes: Uint8Array, mime: string): string {
    const name = nameFor(bytes, mime)
    this.db.prepare('INSERT OR IGNORE INTO blob_data (name, mime, data) VALUES (?, ?, ?)').run(name, mimeOf(name), Buffer.from(bytes))
    return `${BLOB_SCHEME}://blob/${name}`
  }

  list(): string[] {
    return (this.db.prepare('SELECT name FROM blob_data ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name)
  }

  has(name: string): boolean {
    return FILE_NAME.test(name) && this.db.prepare('SELECT 1 FROM blob_data WHERE name = ?').get(name) !== undefined
  }

  read(name: string): Uint8Array {
    checkName(name)
    const row = this.db.prepare('SELECT data FROM blob_data WHERE name = ?').get(name) as { data: Buffer } | undefined
    if (!row) throw new Error(`No such blob: ${name}`)
    return new Uint8Array(row.data)
  }

  write(name: string, bytes: Uint8Array): void {
    checkName(name)
    this.db
      .prepare('INSERT INTO blob_data (name, mime, data) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data')
      .run(name, mimeOf(name), Buffer.from(bytes))
  }

  readForUrl(url: string): { bytes: Uint8Array; mime: string } | null {
    const name = blobNameFromUrl(url)
    if (!name) return null
    const row = this.db.prepare('SELECT mime, data FROM blob_data WHERE name = ?').get(name) as { mime: string; data: Buffer } | undefined
    return row ? { bytes: new Uint8Array(row.data), mime: row.mime } : null
  }
}
