import type { GraphSource, OneNoteNotebook, OneNotePageMeta, OneNoteSection, OneNoteSectionGroup } from './types'

const PUBLIC_GRAPH = 'https://graph.microsoft.com/v1.0'

export interface GraphClientOptions {
  baseUrl: string
  getToken: () => Promise<string>
  fetch?: typeof fetch
  maxConcurrent?: number
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

/** A non-OK Graph response; `status` lets callers tell 401 (sign in again) from the rest. */
export class GraphError extends Error {
  readonly status: number

  constructor(status: number, path: string) {
    super(`Graph ${status} ${path}`)
    this.status = status
  }
}

/** Authenticated Graph requests: bounded concurrency, 429/503 retried honouring Retry-After. */
export class GraphHttp {
  readonly baseUrl: string
  private readonly getToken: () => Promise<string>
  private readonly doFetch: typeof fetch
  private readonly maxConcurrent: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  private active = 0
  private waiting: Array<() => void> = []

  constructor(opts: GraphClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.getToken = opts.getToken
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.maxConcurrent = opts.maxConcurrent ?? 2
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRetries = opts.maxRetries ?? 5
  }

  /** A path under the base URL, or an absolute URL; public Graph URLs (from nextLinks) map onto the base. */
  url(pathOrUrl: string): string {
    if (pathOrUrl.startsWith(PUBLIC_GRAPH)) return this.baseUrl + pathOrUrl.slice(PUBLIC_GRAPH.length)
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : this.baseUrl + pathOrUrl
  }

  async json<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(pathOrUrl, init)
    return (await res.json()) as T
  }

  async bytes(pathOrUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.send(pathOrUrl, {})
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
  }

  async send(pathOrUrl: string, init: RequestInit): Promise<Response> {
    const url = this.url(pathOrUrl)
    await this.acquire()
    try {
      for (let attempt = 0; ; attempt++) {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${await this.getToken()}`)
        const res = await this.doFetch(url, { ...init, headers })
        if (res.ok) return res
        if ((res.status !== 429 && res.status !== 503) || attempt >= this.maxRetries) {
          throw new GraphError(res.status, new URL(url).pathname)
        }
        const header = res.headers.get('retry-after')
        const seconds = header === null ? NaN : Number(header)
        await this.sleep(Number.isFinite(seconds) ? seconds * 1000 : 2 ** attempt * 1000)
      }
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
}

interface Named {
  id: string
  displayName?: string
  lastModifiedDateTime?: string
}

export class GraphClient implements GraphSource {
  private readonly http: GraphHttp

  constructor(opts: GraphClientOptions | GraphHttp) {
    this.http = opts instanceof GraphHttp ? opts : new GraphHttp(opts)
  }

  async listTree(): Promise<OneNoteNotebook[]> {
    const notebooks = await this.list<Named>('/me/onenote/notebooks?$select=id,displayName')
    const out: OneNoteNotebook[] = []
    // Sequential: the semaphore bounds load, and the order stays the server's.
    for (const nb of notebooks) {
      const base = `/me/onenote/notebooks/${nb.id}`
      out.push({
        id: nb.id,
        name: nb.displayName ?? '',
        sections: await this.sections(base),
        sectionGroups: await this.groups(base)
      })
    }
    return out
  }

  async listPages(sectionId: string): Promise<OneNotePageMeta[]> {
    const items = await this.list<Named & { title?: string; level?: number; order?: number }>(
      `/me/onenote/sections/${sectionId}/pages?pagelevel=true&$select=id,title,level,order,lastModifiedDateTime&$top=100`
    )
    return items
      .map((p) => ({
        id: p.id,
        title: p.title ?? '',
        level: p.level ?? 0,
        order: p.order ?? 0,
        lastModified: p.lastModifiedDateTime ?? ''
      }))
      .sort((a, b) => a.order - b.order)
  }

  async pageContent(pageId: string): Promise<string> {
    const res = await this.http.send(`/me/onenote/pages/${pageId}/content?includeIDs=true`, {})
    return res.text()
  }

  async resource(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    // The bearer token only ever goes to the configured Graph host.
    if (!url.startsWith(PUBLIC_GRAPH) && !url.startsWith(this.http.baseUrl)) {
      throw new Error(`Refusing resource outside Graph: ${new URL(url).host}`)
    }
    return this.http.bytes(url)
  }

  private async sections(base: string): Promise<OneNoteSection[]> {
    const items = await this.list<Named>(`${base}/sections?$select=id,displayName,lastModifiedDateTime`)
    return items.map((s) => ({ id: s.id, name: s.displayName ?? '', lastModified: s.lastModifiedDateTime ?? '' }))
  }

  private async groups(base: string): Promise<OneNoteSectionGroup[]> {
    const items = await this.list<Named>(`${base}/sectionGroups?$select=id,displayName`)
    const out: OneNoteSectionGroup[] = []
    for (const g of items) {
      const gBase = `/me/onenote/sectionGroups/${g.id}`
      out.push({
        id: g.id,
        name: g.displayName ?? '',
        sections: await this.sections(gBase),
        sectionGroups: await this.groups(gBase)
      })
    }
    return out
  }

  /** Follows `@odata.nextLink` until the collection is exhausted. */
  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = path
    while (next) {
      const body: { value: T[]; '@odata.nextLink'?: string } = await this.http.json(next)
      items.push(...body.value)
      next = body['@odata.nextLink']
    }
    return items
  }
}
