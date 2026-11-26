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
