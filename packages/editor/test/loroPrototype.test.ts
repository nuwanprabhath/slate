// @vitest-environment happy-dom
import { LoroDoc, LoroMap } from 'loro-crdt'
import { expect, it } from 'vitest'

// The attribute-delete guard belongs to the binding (see loroGuard.ts). If it is put back on
// LoroMap's prototype, the renderer's copy of the library stops behaving like the one main, sync
// and MCP load, and the same document code means different things by process.

it('leaves LoroMap.prototype.delete as the library shipped it when the editor loads', async () => {
  const shipped = LoroMap.prototype.delete
  await import('../src/index')
  expect(LoroMap.prototype.delete).toBe(shipped)
})

it('records a delete of an unseen key on a plain doc, as the library does, after the editor loads', async () => {
  await import('../src/index')
  const doc = new LoroDoc()
  const map = doc.getMap('m')
  const before = doc.oplogVersion()
  map.delete('never-set')
  doc.commit()
  const ops = doc.exportJsonUpdates(before).changes.flatMap((c) => c.ops)
  expect(ops).toHaveLength(1)
})
