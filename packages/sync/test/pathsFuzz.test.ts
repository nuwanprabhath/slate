// Remote paths are what a hostile drive controls most directly: parsing one never throws, and the paths this
// engine writes parse back to exactly the document, device and sequence that went in.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { chunkPath, parseRemotePath, snapshotPath } from '../src/paths'
import { fcParams } from '../../desktop/test/fuzz'

const docId = fc.tuple(fc.constantFrom('page', 'notebook'), fc.uuid()).map(([kind, uuid]) => `${kind}:${uuid}`)
// Device ids are `newId()` uuids in the app; a wider alphabet (no `/`, which separates segments) covers older ones.
const deviceId = fc.oneof(fc.uuid(), fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/))
const seq = fc.nat({ max: Number.MAX_SAFE_INTEGER })
const segment = fc.oneof(
  fc.constantFrom('docs', 'blobs', 'devices', '', '.', '..', 'x.json', '00000001.chunk', 'snapshot-00000001.bin', 'page_a_b', 'page:a'),
  fc.string({ unit: 'binary', maxLength: 12 })
)
const hostilePath = fc.oneof(fc.string({ unit: 'binary', maxLength: 80 }), fc.array(segment, { maxLength: 6 }).map((parts) => parts.join('/')))

describe('parseRemotePath', () => {
  it('T-F2C-01: never throws on any path, and names a kind', () => {
    fc.assert(
      fc.property(hostilePath, (path) => {
        const parsed = parseRemotePath(path)
        expect(['chunk', 'snapshot', 'blob', 'device', 'other']).toContain(parsed.kind)
      }),
      fcParams
    )
  })

  it('T-F2C-02: chunkPath and snapshotPath parse back to what went in', () => {
    fc.assert(
      fc.property(docId, deviceId, seq, (d, dev, n) => {
        expect(parseRemotePath(chunkPath(d, dev, n))).toEqual({ kind: 'chunk', docId: d, deviceId: dev, seq: n })
        expect(parseRemotePath(snapshotPath(d, dev, n))).toEqual({ kind: 'snapshot', docId: d, deviceId: dev, seq: n })
      }),
      fcParams
    )
  })
})
