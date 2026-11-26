// GDPR-04 (workstream D): images no page refers to any more can be removed, by name or by a sweep.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOB_PUT_GRACE_MS, DbBlobStore, FileBlobStore, type BlobStore } from './blobs'
import { openDatabase } from './db/openDatabase'
import { testKey } from './db/testModule'

const implementations: Array<[string, () => BlobStore]> = [
  ['FileBlobStore', () => new FileBlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-gc-')))],
  ['DbBlobStore', () => new DbBlobStore(openDatabase(join(mkdtempSync(join(tmpdir(), 'slate-blobs-gc-')), 'slate.db'), testKey()))],
]

const nameOf = (url: string) => url.slice('slate-blob://blob/'.length)
afterEach(() => vi.useRealTimers())

/** Puts as if `msAgo` milliseconds ago, so the sweep's grace for a fresh paste has passed. */
function putAgo(blobs: BlobStore, bytes: number[], msAgo: number): string {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - msAgo)
  try {
    return nameOf(blobs.put(new Uint8Array(bytes), 'image/png'))
  } finally {
    vi.useRealTimers()
  }
}

describe.each(implementations)('%s', (_name, make) => {
  it('remove deletes one image by name, and refuses a name that is not a blob name', () => {
    const blobs = make()
    const a = nameOf(blobs.put(new Uint8Array([1]), 'image/png'))
    const b = nameOf(blobs.put(new Uint8Array([2]), 'image/png'))
    blobs.remove(a)
    expect(blobs.has(a)).toBe(false)
    expect(blobs.list()).toEqual([b])
    expect(() => blobs.remove('../slate.db')).toThrow(/Bad blob name/)
    blobs.remove(a)
    expect(blobs.list()).toEqual([b])
  })

  it('sweep removes images in neither set and counts them', () => {
    const blobs = make()
    const old = BLOB_PUT_GRACE_MS + 1000
    const used = putAgo(blobs, [1], old)
    const waiting = putAgo(blobs, [2], old)
    const orphan = putAgo(blobs, [3], old)
    expect(blobs.sweep(new Set([used]), new Set([waiting]))).toBe(1)
    expect(blobs.list().sort()).toEqual([used, waiting].sort())
    expect(blobs.has(orphan)).toBe(false)
  })

  it('sweep keeps an image put moments ago: its page edit may not be saved yet', () => {
    const blobs = make()
    const fresh = nameOf(blobs.put(new Uint8Array([4]), 'image/png'))
    expect(blobs.sweep(new Set(), new Set())).toBe(0)
    expect(blobs.has(fresh)).toBe(true)
  })

  it('sweep removes an image written under a known name (sync) that nothing refers to', () => {
    const blobs = make()
    const name = `${'a'.repeat(64)}.png`
    blobs.write(name, new Uint8Array([5]))
    expect(blobs.sweep(new Set(), new Set())).toBe(1)
    expect(blobs.list()).toEqual([])
  })
})

describe('FileBlobStore sweep', () => {
  it('leaves files that are not blob names, and never follows a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-blobs-gc-'))
    const outside = mkdtempSync(join(tmpdir(), 'slate-blobs-gc-outside-'))
    writeFileSync(join(outside, 'precious.txt'), 'x')
    const blobs = new FileBlobStore(dir)
    writeFileSync(join(dir, 'notes.txt'), 'not an image')
    symlinkSync(outside, join(dir, `${'b'.repeat(64)}.png`))
    blobs.sweep(new Set(), new Set())
    expect(readdirSync(dir).sort()).toEqual(['notes.txt'])
    expect(readdirSync(outside)).toEqual(['precious.txt'])
  })
})
