// GDPR-07 (workstream D): an agent's search query is personal content, so the audit row records
// only how long it was, never the words.
import { describe, expect, it } from 'vitest'
import { search } from '../src/tools'
import { memorySource } from './memorySource'

describe('audit minimisation (GDPR-07)', () => {
  it('stores a search as its length, not its query', async () => {
    const { source, audits, seed } = memorySource()
    const { ops, grant } = seed()
    grant(ops, 'read')
    await search(source, 'Anna diabetes kubectl')
    expect(audits.at(-1)).toEqual({ tool: 'search', target: '[21 chars]', outcome: 'ok' })
  })

  it('stores none of the words of a non-ASCII query, only its string length', async () => {
    const { source, audits } = memorySource()
    await search(source, 'Zoë 🙂 rash')
    const row = audits.at(-1)!
    expect(row.target).toBe('[11 chars]')
    for (const word of ['Zoë', 'rash']) expect(row.target).not.toContain(word)
  })
})
