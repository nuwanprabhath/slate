import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from './blobs'

describe('BlobStore', () => {
  it('stores bytes content-addressed and resolves the URL back to the file', () => {
    const blobs = new BlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-')))
    const bytes = new Uint8Array([137, 80, 78, 71])
    const url = blobs.put(bytes, 'image/png')
    expect(url).toMatch(/^slate-blob:\/\/blob\/[a-f0-9]{64}\.png$/)
    expect(blobs.put(bytes, 'image/png')).toBe(url)
    expect(Array.from(readFileSync(blobs.pathForUrl(url)!))).toEqual(Array.from(bytes))
  })

  it('rejects foreign or malformed URLs', () => {
    const blobs = new BlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-')))
    expect(blobs.pathForUrl('file:///etc/passwd')).toBeNull()
    expect(blobs.pathForUrl('slate-blob://other/' + 'a'.repeat(64) + '.png')).toBeNull()
    expect(blobs.pathForUrl('slate-blob://blob/../../etc/passwd')).toBeNull()
    expect(blobs.pathForUrl('not a url')).toBeNull()
  })
})
