import { describe, expect, it } from 'vitest'
import { chunkPath, docIdFromKey, docKey, parseRemotePath, snapshotPath } from '../src/paths'

describe('remote paths', () => {
  it('maps doc ids to folder-safe keys and back', () => {
    expect(docKey('page:abc')).toBe('page_abc')
    expect(docIdFromKey(docKey('page:abc'))).toBe('page:abc')
    expect(docIdFromKey(docKey('notebook:1f-2e'))).toBe('notebook:1f-2e')
  })

  it('zero-pads chunk and snapshot sequence numbers', () => {
    expect(chunkPath('page:abc', 'dev1', 7)).toBe('docs/page_abc/dev1/00000007.chunk')
    expect(snapshotPath('page:abc', 'dev1', 52)).toBe('docs/page_abc/dev1/snapshot-00000052.bin')
  })

  it('round-trips every kind', () => {
    expect(parseRemotePath(chunkPath('page:abc', 'dev1', 7))).toEqual({ kind: 'chunk', docId: 'page:abc', deviceId: 'dev1', seq: 7 })
    expect(parseRemotePath(snapshotPath('notebook:n', 'd-2', 12))).toEqual({
      kind: 'snapshot',
      docId: 'notebook:n',
      deviceId: 'd-2',
      seq: 12
    })
    expect(parseRemotePath('blobs/ab12.png')).toEqual({ kind: 'blob', name: 'ab12.png' })
    expect(parseRemotePath('devices/dev1.json')).toEqual({ kind: 'device' })
    expect(parseRemotePath('docs/page_abc/dev1')).toEqual({ kind: 'other' })
    expect(parseRemotePath('docs/page_abc/dev1/notes.txt')).toEqual({ kind: 'other' })
    expect(parseRemotePath('')).toEqual({ kind: 'other' })
  })
})
