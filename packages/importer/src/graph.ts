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

interface Named {
  id: string
  displayName?: string
  lastModifiedDateTime?: string
}

export class GraphClient implements GraphSource {
  private readonly baseUrl: string
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
    const res = await this.request(`${this.baseUrl}/me/onenote/pages/${pageId}/content?includeIDs=true`)
    return res.text()
  }

  async resource(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    let target = url
    if (url.startsWith(PUBLIC_GRAPH)) target = this.baseUrl + url.slice(PUBLIC_GRAPH.length)
    // The bearer token only ever goes to the configured Graph host.
    else if (!url.startsWith(this.baseUrl)) throw new Error(`Refusing resource outside Graph: ${new URL(url).host}`)
    const res = await this.request(target)
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
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
    let next: string | undefined = this.baseUrl + path
    while (next) {
      const res: Response = await this.request(next)
      const body = (await res.json()) as { value: T[]; '@odata.nextLink'?: string }
      items.push(...body.value)
      next = body['@odata.nextLink']
      if (next?.startsWith(PUBLIC_GRAPH)) next = this.baseUrl + next.slice(PUBLIC_GRAPH.length)
    }
    return items
  }

  private async request(url: string): Promise<Response> {
    await this.acquire()
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await this.doFetch(url, { headers: { Authorization: `Bearer ${await this.getToken()}` } })
        if (res.ok) return res
        if ((res.status !== 429 && res.status !== 503) || attempt >= this.maxRetries) {
          throw new Error(`Graph ${res.status} ${new URL(url).pathname}`)
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
