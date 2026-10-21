import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphClient } from '../src/graph'
import { startFakeGraph } from './fakeGraph'
import type { FakeGraph, FakeGraphData } from './fakeGraph'

const page = (n: number) => ({
  id: `p${n}`,
  title: `Page ${n}`,
  level: 0,
  order: n,
  lastModified: '2026-01-01T00:00:00Z',
  html: `<html><body><p>page ${n}</p></body></html>`
})

const data: FakeGraphData = {
  notebooks: [
    {
      id: 'nb1',
      name: 'Work',
      sections: [{ id: 's1', name: 'Inbox', pages: [page(3), page(1), page(2), page(4), page(5)] }],
      sectionGroups: [{ id: 'g1', name: 'Projects', sections: [{ id: 's2', name: 'Alpha', pages: [] }], sectionGroups: [] }]
    }
  ]
}

describe('GraphClient', () => {
  let fake: FakeGraph
  let sleeps: number[]
  const client = (over: Partial<ConstructorParameters<typeof GraphClient>[0]> = {}, token = 'fake-token') =>
    new GraphClient({
      baseUrl: fake.url,
      getToken: async () => token,
      sleep: async (ms) => void sleeps.push(ms),
      ...over
    })

  beforeEach(async () => {
    sleeps = []
    fake = await startFakeGraph(structuredClone(data))
  })
  afterEach(() => fake.close())

  it('lists the nested tree', async () => {
    const tree = await client().listTree()
    expect(tree).toHaveLength(1)
    expect(tree[0]!.name).toBe('Work')
    expect(tree[0]!.sections.map((s) => s.name)).toEqual(['Inbox'])
    expect(tree[0]!.sections[0]!.lastModified).toBe('2026-01-01T00:00:00Z')
    expect(tree[0]!.sectionGroups.map((g) => g.name)).toEqual(['Projects'])
    expect(tree[0]!.sectionGroups[0]!.sections.map((s) => s.id)).toEqual(['s2'])
  })

  it('follows paging and sorts pages by order', async () => {
    const pages = await client().listPages('s1')
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(fake.requests.filter((r) => r.includes('/sections/s1/pages')).length).toBeGreaterThan(1)
  })

  it('returns page html', async () => {
    expect(await client().pageContent('p2')).toContain('page 2')
  })

  it('returns resource bytes and mime, rewriting the public Graph url', async () => {
    const r = await client().resource('https://graph.microsoft.com/v1.0/resources/img1/$value')
    expect(r.mime).toBe('image/png')
    expect(Array.from(r.bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    expect(fake.requests).toContain('/resources/img1/$value')
  })

  it('retries 429 honouring Retry-After', async () => {
    fake.failNext(429, 2, 1)
    expect(await client().pageContent('p1')).toContain('page 1')
    expect(sleeps).toEqual([1000, 1000])
  })

  it('backs off exponentially without Retry-After', async () => {
    fake.failNext(503, 3)
    await client().pageContent('p1')
    expect(sleeps).toEqual([1000, 2000, 4000])
  })

  it('gives up after maxRetries with the status and path in the message', async () => {
    fake.failNext(503, 6)
    const err = await client().pageContent('p1').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('503')
    expect((err as Error).message).toContain('/me/onenote/pages/p1/content')
  })

  it('never has more than maxConcurrent requests in flight', async () => {
    const c = client({ maxConcurrent: 2 })
    await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5', 'p1'].map((id) => c.pageContent(id)))
    expect(fake.peakConcurrent).toBe(2)
  })

  it('sends the bearer token and keeps it out of errors', async () => {
    const err = await client({}, 'wrong-token').pageContent('p1').catch((e: Error) => e)
    expect((err as Error).message).toContain('401')
    expect((err as Error).message).not.toContain('wrong-token')
  })

  it('refuses to send the token to resources outside Graph', async () => {
    await expect(client().resource('https://evil.example/x.png')).rejects.toThrow(/Refusing/)
  })

  it('setPage replaces a page for later reads', async () => {
    fake.setPage('s1', { ...page(1), lastModified: '2026-02-02T00:00:00Z', html: '<p>changed</p>' })
    expect(await client().pageContent('p1')).toContain('changed')
    expect((await client().listPages('s1'))[0]!.lastModified).toBe('2026-02-02T00:00:00Z')
  })
})
