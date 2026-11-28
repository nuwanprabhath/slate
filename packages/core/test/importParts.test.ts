import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { importParts } from '../src/importParts'
import { PageDoc } from '../src/page'
import { NotebookDoc } from '../src/tree'

/** "hello" -> "hello world" -> "world": three commits before the shallow point, then "X" after it. */
function erasedHistory(): { shallow: Uint8Array; later: Uint8Array; full: Uint8Array[] } {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  const updates: Uint8Array[] = []
  doc.subscribeLocalUpdates((u) => updates.push(u))
  const text = doc.getText('t')
  text.insert(0, 'hello')
  doc.commit()
  text.insert(5, ' world')
  doc.commit()
  text.delete(0, 6)
  doc.commit()
  const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })
  const from = doc.oplogVersion()
  text.insert(0, 'X')
  doc.commit()
  const later = doc.export({ mode: 'update', from })
  text.free()
  doc.free()
  return { shallow, later, full: updates }
}

const textOf = (doc: LoroDoc) => doc.getText('t').toString()

describe('importParts', () => {
  it('reads a shallow snapshot with two or more commits before it, followed by a later update (Loro 1.17 importBatch leaves that empty)', () => {
    const { shallow, later } = erasedHistory()
    const doc = new LoroDoc()
    const status = importParts(doc, [shallow, later])
    expect(textOf(doc)).toBe('Xworld')
    expect(status.pending).toBeNull()
  })

  it('reads a shallow snapshot alone, and several updates after it', () => {
    const { shallow, later } = erasedHistory()
    const alone = new LoroDoc()
    importParts(alone, [shallow])
    expect(textOf(alone)).toBe('world')
    const twice = new LoroDoc()
    expect(importParts(twice, [shallow, later, later]).pending).toBeNull()
    expect(textOf(twice)).toBe('Xworld')
  })

  it('reads full history as importBatch does, and reports an update whose base is missing as pending', () => {
    const { full } = erasedHistory()
    const doc = new LoroDoc()
    expect(importParts(doc, full).pending).toBeNull()
    expect(textOf(doc)).toBe('Xworld')
    const gapped = new LoroDoc()
    expect(importParts(gapped, full.slice(1)).pending).not.toBeNull()
  })

  it('reads a shallow snapshot stored after the update built on it, as a v0.7.14 device stores a git listing (chunks sort first)', () => {
    const { shallow, later } = erasedHistory()
    const doc = new LoroDoc()
    const status = importParts(doc, [later, shallow])
    expect(textOf(doc)).toBe('Xworld')
    expect(status.pending).toBeNull()
  })

  it('loads full history followed by a shallow snapshot of it exactly as importBatch does', () => {
    const { shallow, later, full } = erasedHistory()
    const parts = [...full.slice(0, 3), shallow, later]
    const doc = new LoroDoc()
    const batch = new LoroDoc()
    batch.importBatch(parts)
    expect(importParts(doc, parts).pending).toBeNull()
    expect(textOf(doc)).toBe(textOf(batch))
    expect(doc.isShallow()).toBe(batch.isShallow())
    expect(doc.oplogVersion().compare(batch.oplogVersion())).toBe(0)
  })

  it('loads a never-erased doc exactly as importBatch does: updates, a compaction snapshot first or later, a gap', () => {
    const doc = new LoroDoc()
    doc.setPeerId(7n)
    const updates: Uint8Array[] = []
    doc.subscribeLocalUpdates((u) => updates.push(u))
    const text = doc.getText('t')
    for (let i = 0; i < 30; i++) {
      text.insert(text.length, `w${i} `)
      doc.commit()
    }
    const snapshot = doc.export({ mode: 'snapshot' })
    const cases = [updates, [snapshot, ...updates.slice(20)], [...updates.slice(0, 10), snapshot, ...updates.slice(25)], updates.slice(3), [snapshot, ...updates.slice(5)]]
    for (const parts of cases) {
      const viaParts = new LoroDoc()
      const viaBatch = new LoroDoc()
      const a = importParts(viaParts, parts)
      const b = viaBatch.importBatch([...parts])
      expect(textOf(viaParts)).toBe(textOf(viaBatch))
      expect(viaParts.isShallow()).toBe(false)
      expect(viaParts.oplogVersion().compare(viaBatch.oplogVersion())).toBe(0)
      expect(a.pending === null || a.pending.size === 0).toBe(b.pending === null || b.pending.size === 0)
    }
    text.free()
  })

  it('does nothing with no parts', () => {
    const doc = new LoroDoc()
    expect(importParts(doc, []).pending).toBeNull()
    expect(textOf(doc)).toBe('')
  })

  it('is what PageDoc.fromUpdates and NotebookDoc.fromUpdates load with', () => {
    const { shallow, later } = erasedHistory()
    expect(textOf(PageDoc.fromUpdates([shallow, later]).doc)).toBe('Xworld')
    expect(textOf(NotebookDoc.fromUpdates([shallow, later]).doc)).toBe('Xworld')
  })
})
