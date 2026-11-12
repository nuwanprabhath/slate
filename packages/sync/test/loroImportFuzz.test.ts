// A hostile remote hands the engine bytes it passes to LoroDoc.import. Loro's decoder is WebAssembly, and every
// document in the process shares that one instance: a decoder fault must stay a thrown error and leave the
// instance able to import the next, unrelated document correctly.
import { describe, expect, it } from 'vitest'
import { LoroDoc, decodeImportBlobMeta } from 'loro-crdt'
import { FUZZ_RUNS, Rng, forAll, fuzzTimeout } from '../../desktop/test/fuzz'
import { mutateBytes } from '../../desktop/test/fuzzBytes'
import { corpusEntries, replayCorpus } from '../../desktop/test/fuzzCorpus'

// Ten PageDoc exports, updates and snapshots, each file named by the first 16 hex of its sha256.
const seeds = corpusEntries('sync', 'loro-update').map((e) => e.bytes)

/** A known update and the JSON a fresh document holds after importing it: the health check after each fault. */
function known(): { bytes: Uint8Array; json: unknown } {
  const doc = new LoroDoc()
  doc.setPeerId(42n)
  doc.getMap('boxes').set('b', 'known')
  doc.getText('t').insert(0, 'still decodes')
  doc.commit()
  return { bytes: doc.export({ mode: 'update' }), json: doc.toJSON() }
}
const KNOWN = known()

function stillHealthy(): void {
  const fresh = new LoroDoc()
  fresh.import(KNOWN.bytes)
  expect(fresh.toJSON()).toEqual(KNOWN.json)
}

/** Import must either throw or return; nothing else (a hang is caught by the test timeout). */
function importOrThrow(doc: LoroDoc, bytes: Uint8Array): 'imported' | 'refused' {
  try {
    doc.import(bytes)
    return 'imported'
  } catch {
    return 'refused'
  }
}

describe('LoroDoc.import of hostile bytes', () => {
  replayCorpus('sync', 'loro-update', (bytes) => {
    // Corpus seeds are real exports: each imports (a delta whose base is missing stays pending, not an error).
    expect(importOrThrow(new LoroDoc(), bytes)).toBe('imported')
    stillHealthy()
  })

  it('T-F2C-03: the corpus holds ten seeds, updates and snapshots', () => {
    expect(seeds.length).toBe(10)
    // Both kinds must be present for the mutations to reach both decoders.
    const modes = new Set(seeds.map((s) => decodeImportBlobMeta(s, true).mode))
    expect([...modes].sort()).toEqual(['snapshot', 'update'])
  })

  it('T-F2C-04: a mutated update or snapshot throws or imports, and a new document still decodes', { timeout: fuzzTimeout(20_000) }, () => {
    const tally = { imported: 0, refused: 0 }
    // One long-lived victim too: a fault must not leave a document other imports still go to in a broken state.
    const victim = new LoroDoc()
    forAll('loro import', (rng: Rng) => {
      const seed = rng.pick(seeds)
      const bytes = mutateBytes(rng, seed)
      tally[importOrThrow(new LoroDoc(), bytes)]++
      importOrThrow(victim, bytes)
      stillHealthy()
    })
    expect(tally.imported + tally.refused).toBe(FUZZ_RUNS)
    expect(tally.refused, 'mutations the decoder refused').toBeGreaterThan(0)
    const after = new LoroDoc()
    after.import(KNOWN.bytes)
    expect(victim.toJSON()).toBeDefined()
    expect(after.toJSON()).toEqual(KNOWN.json)
  })
})
