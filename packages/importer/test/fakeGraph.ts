import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeSection {
  id: string
  name: string
  pages: Array<{ id: string; title: string; level: number; order: number; lastModified: string; html: string }>
}

export interface FakeGraphData {
  notebooks: Array<{
    id: string
    name: string
    sections: FakeSection[]
    sectionGroups: Array<{ id: string; name: string; sections: FakeSection[]; sectionGroups: [] }>
  }>
}

export interface FakeGraph {
  url: string
  /** Every request path (with query) seen, including rejected and failed ones. */
  requests: string[]
  /** Highest number of requests in flight at once. */
  readonly peakConcurrent: number
  failNext(status: number, times: number, retryAfter?: number): void
  /** Adds or replaces a page (matched by id) in a section, e.g. to change its html or lastModified. */
  setPage(sectionId: string, page: FakeSection['pages'][number]): void
  close(): Promise<void>
}

// A valid 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const PAGE_SIZE = 2
const LATENCY_MS = 15

export async function startFakeGraph(data: FakeGraphData): Promise<FakeGraph> {
  const requests: string[] = []
  const failures: Array<{ status: number; times: number; retryAfter?: number }> = []
  let inFlight = 0
  let peak = 0
  let baseUrl = ''

  const allSections = (): FakeSection[] =>
    data.notebooks.flatMap((n) => [...n.sections, ...n.sectionGroups.flatMap((g) => g.sections)])
  const findSection = (id: string) => allSections().find((s) => s.id === id)

  function paged<T>(items: T[], query: URLSearchParams, pathname: string, size: number) {
    const skip = Number(query.get('skip') ?? 0)
    const value = items.slice(skip, skip + size)
    const body: { value: T[]; '@odata.nextLink'?: string } = { value }
    if (skip + size < items.length) {
      const q = new URLSearchParams(query)
      q.set('skip', String(skip + size))
      body['@odata.nextLink'] = `${baseUrl}${pathname}?${q.toString()}`
    }
    return body
  }

  function route(pathname: string, query: URLSearchParams, res: ServerResponse): void {
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const notFound = () => {
      res.writeHead(404)
      res.end()
    }
    const sec = (s: FakeSection) => ({
      id: s.id,
      displayName: s.name,
      lastModifiedDateTime: s.pages.map((p) => p.lastModified).sort().pop() ?? '2020-01-01T00:00:00Z'
    })
    let m: RegExpMatchArray | null

    if (pathname === '/me/onenote/notebooks') {
      return json(paged(data.notebooks.map((n) => ({ id: n.id, displayName: n.name })), query, pathname, 100))
    }
    if ((m = pathname.match(/^\/me\/onenote\/notebooks\/([^/]+)\/(sections|sectionGroups)$/))) {
      const nb = data.notebooks.find((n) => n.id === m![1])
      if (!nb) return notFound()
      const items = m[2] === 'sections' ? nb.sections.map(sec) : nb.sectionGroups.map((g) => ({ id: g.id, displayName: g.name }))
      return json(paged(items, query, pathname, 100))
    }
    if ((m = pathname.match(/^\/me\/onenote\/sectionGroups\/([^/]+)\/(sections|sectionGroups)$/))) {
      const g = data.notebooks.flatMap((n) => n.sectionGroups).find((x) => x.id === m![1])
      if (!g) return notFound()
      const items = m[2] === 'sections' ? g.sections.map(sec) : []
      return json(paged(items, query, pathname, 100))
    }
    if ((m = pathname.match(/^\/me\/onenote\/sections\/([^/]+)\/pages$/))) {
      const s = findSection(m[1]!)
      if (!s) return notFound()
      const items = s.pages.map((p) => ({
        id: p.id,
        title: p.title,
        level: p.level,
        order: p.order,
        lastModifiedDateTime: p.lastModified
      }))
      return json(paged(items, query, pathname, PAGE_SIZE))
    }
    if ((m = pathname.match(/^\/me\/onenote\/pages\/([^/]+)\/content$/))) {
      const p = allSections().flatMap((s) => s.pages).find((x) => x.id === m![1])
      if (!p) return notFound()
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return void res.end(p.html)
    }
    if (/^\/resources\/[^/]+\/\$value$/.test(pathname)) {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return void res.end(PNG)
    }
    notFound()
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    requests.push(req.url ?? '')
    inFlight++
    peak = Math.max(peak, inFlight)
    res.on('close', () => {
      inFlight--
    })
    // Hold each request briefly so overlapping requests are observable.
    setTimeout(() => {
      if (req.headers.authorization !== 'Bearer fake-token') {
        res.writeHead(401)
        return void res.end()
      }
      const failure = failures[0]
      if (failure) {
        if (--failure.times <= 0) failures.shift()
        const headers: Record<string, string> = {}
        if (failure.retryAfter !== undefined) headers['Retry-After'] = String(failure.retryAfter)
        res.writeHead(failure.status, headers)
        return void res.end()
      }
      const u = new URL(req.url ?? '/', baseUrl)
      route(u.pathname, u.searchParams, res)
    }, LATENCY_MS)
  }

  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('fake graph failed to bind')
  baseUrl = `http://127.0.0.1:${addr.port}`

  return {
    url: baseUrl,
    requests,
    get peakConcurrent() {
      return peak
    },
    failNext(status, times, retryAfter) {
      failures.push({ status, times, retryAfter })
    },
    setPage(sectionId, p) {
      const s = findSection(sectionId)
      if (!s) throw new Error(`no section ${sectionId}`)
      const i = s.pages.findIndex((x) => x.id === p.id)
      if (i >= 0) s.pages[i] = p
      else s.pages.push(p)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
