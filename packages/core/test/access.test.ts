import { describe, expect, it } from 'vitest'
import { NOTEBOOK_SCOPE, NotebookDoc } from '../src/tree'

function sample() {
  const nb = NotebookDoc.create('N')
  const group = nb.addSectionGroup('G')
  const inGroup = nb.addSection('In group', group)
  const loose = nb.addSection('Loose')
  const p1 = nb.addPage(inGroup, 'P1')
  const p2 = nb.addPage(loose, 'P2')
  return { nb, group, inGroup, loose, p1, p2 }
}

describe('NotebookDoc access', () => {
  it('denies everything by default', () => {
    const { nb, inGroup, p1 } = sample()
    expect(nb.effectiveAccess(inGroup)).toBeNull()
    expect(nb.effectiveAccess(p1.id)).toBeNull()
  })

  it('applies a notebook-wide grant to every node', () => {
    const { nb, p1, p2 } = sample()
    nb.setAccess(NOTEBOOK_SCOPE, 'read')
    expect(nb.effectiveAccess(p1.id)).toBe('read')
    expect(nb.effectiveAccess(p2.id)).toBe('read')
  })

  it('applies a container grant to its descendants only', () => {
    const { nb, group, p1, p2 } = sample()
    nb.setAccess(group, 'readwrite')
    expect(nb.effectiveAccess(p1.id)).toBe('readwrite')
    expect(nb.effectiveAccess(p2.id)).toBeNull()
  })

  it('lets the nearest explicit grant win', () => {
    const { nb, inGroup, p1 } = sample()
    nb.setAccess(NOTEBOOK_SCOPE, 'readwrite')
    nb.setAccess(inGroup, 'read')
    expect(nb.effectiveAccess(p1.id)).toBe('read')
  })

  it('revokes a grant with null and exposes explicit grants on items', () => {
    const { nb, loose, p2 } = sample()
    nb.setAccess(loose, 'read')
    expect(nb.get(loose)!.access).toBe('read')
    expect(nb.get(p2.id)!.access).toBeNull()
    nb.setAccess(loose, null)
    expect(nb.effectiveAccess(p2.id)).toBeNull()
    expect(nb.accessOf(loose)).toBeNull()
  })

  it('finds pages by page id and returns null access for unknown ids', () => {
    const { nb, p2 } = sample()
    expect(nb.findPage(p2.pageId)!.id).toBe(p2.id)
    expect(nb.findPage('nope')).toBeUndefined()
    expect(nb.effectiveAccess('0@0' as never)).toBeNull()
  })

  it('persists grants through updates', () => {
    const { nb, loose } = sample()
    nb.setAccess(loose, 'readwrite')
    const copy = NotebookDoc.fromUpdates([nb.doc.export({ mode: 'snapshot' })])
    expect(copy.accessOf(loose)).toBe('readwrite')
  })
})
