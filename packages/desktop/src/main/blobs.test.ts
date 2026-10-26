import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DbBlobStore, FileBlobStore, ImageTooLarge, MAX_IMAGE_BYTES, type BlobStore } from './blobs'
import { openDatabase } from './db/openDatabase'
import { testKey } from './db/testModule'

const implementations: Array<[string, () => BlobStore]> = [
  ['FileBlobStore', () => new FileBlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-')))],
  ['DbBlobStore', () => new DbBlobStore(openDatabase(join(mkdtempSync(join(tmpdir(), 'slate-blobs-')), 'slate.db'), testKey()))],
]

describe.each(implementations)('%s', (_name, make) => {
  it('stores bytes content-addressed and resolves the URL back to the bytes', () => {
    const blobs = make()
    const bytes = new Uint8Array([137, 80, 78, 71])
    const url = blobs.put(bytes, 'image/png')
    expect(url).toMatch(/^slate-blob:\/\/blob\/[a-f0-9]{64}\.png$/)
    expect(blobs.put(bytes, 'image/png')).toBe(url)
    const found = blobs.readForUrl(url)!
    expect(Array.from(found.bytes)).toEqual(Array.from(bytes))
    expect(found.mime).toBe('image/png')
    const name = url.slice('slate-blob://blob/'.length)
    expect(blobs.list()).toEqual([name])
    expect(blobs.has(name)).toBe(true)
    expect(Array.from(blobs.read(name))).toEqual(Array.from(bytes))
  })

  it('writes bytes under a known name', () => {
    const blobs = make()
    const name = `${'b'.repeat(64)}.jpg`
    expect(blobs.has(name)).toBe(false)
    blobs.write(name, new Uint8Array([9]))
    expect(blobs.has(name)).toBe(true)
    expect(blobs.readForUrl(`slate-blob://blob/${name}`)?.mime).toBe('image/jpeg')
    expect(() => blobs.write('../x.png', new Uint8Array([1]))).toThrow()
  })

  it('rejects foreign or malformed URLs', () => {
    const blobs = make()
    expect(blobs.readForUrl('file:///etc/passwd')).toBeNull()
    expect(blobs.readForUrl('slate-blob://other/' + 'a'.repeat(64) + '.png')).toBeNull()
    expect(blobs.readForUrl('slate-blob://blob/../../etc/passwd')).toBeNull()
    expect(blobs.readForUrl('not a url')).toBeNull()
    expect(blobs.readForUrl('slate-blob://blob/' + 'a'.repeat(64) + '.png')).toBeNull()
  })

  it('refuses images over 64 MiB', () => {
    const blobs = make()
    expect(() => blobs.put(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png')).toThrow(ImageTooLarge)
    expect(blobs.list()).toEqual([])
  })
})

describe('DbBlobStore', () => {
  it('writes no files beside the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-blobs-'))
    const db = openDatabase(join(dir, 'slate.db'), testKey())
    new DbBlobStore(db).put(new Uint8Array([1, 2]), 'image/gif')
    db.close()
    expect(readdirSync(dir)).toEqual(['slate.db'])
    expect(existsSync(join(dir, 'blobs'))).toBe(false)
  })
})
