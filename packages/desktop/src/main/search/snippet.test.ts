import { describe, expect, it } from 'vitest'
import { snippetAround } from './snippet'

describe('snippetAround', () => {
  it('keeps short text whole', () => {
    expect(snippetAround('run kubectl now', 4, 11, 40)).toEqual({ snippet: 'run kubectl now', range: [4, 11] })
  })

  it('starts and ends on word boundaries, marking cut text with an ellipsis', () => {
    const text = 'kubectl -n api rollout restart deploy/api kubectl -n api rollout status deploy/api --timeout=120s'
    const from = text.indexOf('kubectl', 1)
    const { snippet, range } = snippetAround(text, from, from + 7, 20)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).not.toMatch(/^…\S*bectl/)
    expect(snippet.slice(range[0], range[1])).toBe('kubectl')
    // No partial word right after the ellipsis.
    expect(text.includes(snippet.slice(1).split(' ')[0]!)).toBe(true)
    expect(snippet.slice(1, 2)).not.toBe(' ')
  })

  it('turns line breaks and hard-break placeholders into spaces', () => {
    const { snippet } = snippetAround('a\nb￼c', 0, 1, 40)
    expect(snippet).toBe('a b c')
  })
})
