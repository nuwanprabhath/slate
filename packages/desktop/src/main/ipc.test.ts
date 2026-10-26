import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import type { SearchQuery } from '../shared/api'
import { isSearchQuery, registerSearchIpc } from './ipc'
import type { Handler, IpcRegistrar } from './ipcGuard'
import type { SearchIndex } from './search/searchIndex'

// The golden-path example for a handler (docs/architecture/golden-paths.md#ipc): it checks every
// argument from the untrusted renderer before main acts on it, and is tested with a fake registrar.
function fakeRegistrar() {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  return { ipc, handlers }
}

const good: SearchQuery = { text: 'zeta', matchCase: false, wholeWord: false, regex: false, scope: { kind: 'all' } }

describe('registerSearchIpc', () => {
  it('passes a well-formed query to the index', () => {
    const { ipc, handlers } = fakeRegistrar()
    const seen: SearchQuery[] = []
    registerSearchIpc(ipc, () => ({ query: (q: SearchQuery) => (seen.push(q), { pages: [], total: 0, truncated: false }) }) as unknown as SearchIndex)
    handlers.get(CH.searchQuery)!({} as never, good)
    expect(seen).toEqual([good])
  })

  it('refuses a malformed query from the renderer before it reaches the index', () => {
    const { ipc, handlers } = fakeRegistrar()
    let called = false
    registerSearchIpc(ipc, () => ({ query: () => ((called = true), { pages: [], total: 0, truncated: false }) }) as unknown as SearchIndex)
    for (const bad of [null, 'zeta', { ...good, text: 5 }, { ...good, scope: { kind: 'notebook' } }, { ...good, regex: 'yes' }, { ...good, text: 'x'.repeat(10_001) }]) {
      expect(() => handlers.get(CH.searchQuery)!({} as never, bad), JSON.stringify(bad)?.slice(0, 40)).toThrow(/search query/)
    }
    expect(called).toBe(false)
  })

  it('isSearchQuery accepts each scope kind', () => {
    expect(isSearchQuery(good)).toBe(true)
    expect(isSearchQuery({ ...good, scope: { kind: 'section', id: 's1' } })).toBe(true)
    expect(isSearchQuery({ ...good, scope: { kind: 'elsewhere' } })).toBe(false)
  })
})
