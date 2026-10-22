import { describe, expect, it } from 'vitest'
import { filterSections } from './search'

const sections = [
  { id: 'autocorrect', label: 'Autocorrect', blurb: 'What changes as you type.', keywords: ['bullets', 'markdown'] },
  { id: 'sync', label: 'Sync', blurb: 'Where notebooks sync to.', keywords: ['git', 'onedrive'] },
  { id: 'general', label: 'General', blurb: 'AI agents and the rest.' },
]

describe('filterSections', () => {
  it('returns every section for an empty query', () => {
    expect(filterSections(sections, '  ').map((s) => s.id)).toEqual(['autocorrect', 'sync', 'general'])
  })

  it('matches label, blurb and keywords, ignoring case', () => {
    expect(filterSections(sections, 'SYNC').map((s) => s.id)).toEqual(['sync'])
    expect(filterSections(sections, 'agents').map((s) => s.id)).toEqual(['general'])
    expect(filterSections(sections, 'git').map((s) => s.id)).toEqual(['sync'])
    expect(filterSections(sections, 'bullet').map((s) => s.id)).toEqual(['autocorrect'])
    expect(filterSections(sections, 'zzz')).toEqual([])
  })
})
