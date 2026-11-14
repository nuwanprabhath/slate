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

/** One request's own deadline: a metadata call, and a transfer of note bytes (B6/F8). */
export const METADATA_TIMEOUT_MS = 60_000
export const TRANSFER_TIMEOUT_MS = 10 * 60_000
/** A server asking for longer than this is waiting for a person, not for sync; sync tries again later. */
export const MAX_RETRY_AFTER_MS = 120_000
/** Everything one request may spend on retries before sync gives up on this run. */
export const RETRY_BUDGET_MS = 10 * 60_000

export interface SendOptions {
  /** The caller's signal (the sync engine's); combined with this request's own deadline. */
  signal?: AbortSignal
  /** Note bytes rather than metadata: the longer deadline. */
  transfer?: boolean
}

/**
 * The request did not finish in time, or the server kept asking Slate to wait: the same answer the
 * engine gives an unreachable drive (`offline`), not a failure to show the user.
 */
export class GraphOfflineError extends Error {
  readonly offline = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GraphOfflineError'
  }
}

/**
 * This request's deadline as a signal. `AbortSignal.timeout` would do, but its timer is neither
 * cancellable (a ten-minute one would outlive every finished transfer) nor one a test can drive.
 */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * Rejects as soon as `signal` aborts, whatever `work` does afterwards. `fetch` honours a signal, but
 * nothing here depends on that: the deadline is kept by this process alone.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** A non-OK Graph response; `status` lets callers tell 401 (sign in again) from the rest. */
export class GraphError extends Error {
  readonly status: number

  constructor(status: number, path: string) {
    super(`Graph ${status} ${path}`)
    this.status = status
  }
}

/**
 * A page file that parsed to no element at all (empty, truncated, only comments or text). Not an
 * empty page: importing it as nothing would lose the notes without saying so.
 */
export class ImportPageError extends Error {
  readonly page: string | undefined

  constructor(page?: string) {
    super(`Page ${page === undefined ? '(unnamed)' : `"${page}"`} could not be read: the file has no content element (damaged or truncated?)`)
    this.name = 'ImportPageError'
    this.page = page
  }
}

/** A loop, not `/\/+$/`: the regex retries from every slash and is quadratic on a long run of them. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
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
    this.baseUrl = withoutTrailingSlashes(opts.baseUrl)
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

  async json<T>(pathOrUrl: string, init: RequestInit = {}, opts: SendOptions = {}): Promise<T> {
    const res = await this.send(pathOrUrl, init, opts)
    return (await res.json()) as T
  }

  async bytes(pathOrUrl: string, opts: SendOptions = {}): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.send(pathOrUrl, {}, opts)
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
  }

  /**
   * One Graph request, retried on 429 and 503. Three things bound it: the caller's signal, this
   * request's own deadline, and a total retry budget. A server's `Retry-After` is honoured only up
   * to `MAX_RETRY_AFTER_MS`; past the budget the call fails as `offline` and sync tries again later.
   */
  async send(pathOrUrl: string, init: RequestInit, opts: SendOptions = {}): Promise<Response> {
    const url = this.url(pathOrUrl)
    const path = new URL(url).pathname
    const deadlineMs = opts.transfer ? TRANSFER_TIMEOUT_MS : METADATA_TIMEOUT_MS
    await this.acquire()
    const startedAt = Date.now()
    try {
      for (let attempt = 0; ; attempt++) {
        const timeout = deadline(deadlineMs)
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${await this.getToken()}`)
        let res: Response
        try {
          res = await untilAborted(this.doFetch(url, { ...init, headers, signal }), signal)
        } catch (err) {
          if (opts.signal?.aborted === true) throw err
          if (timeout.signal.aborted) throw new GraphOfflineError(`Graph ${path} did not answer within ${deadlineMs} ms`, { cause: err })
          throw err
        } finally {
          timeout.done()
        }
        if (res.ok) return res
        if ((res.status !== 429 && res.status !== 503) || attempt >= this.maxRetries) {
          throw new GraphError(res.status, path)
        }
        const header = res.headers.get('retry-after')
        const seconds = header === null ? NaN : Number(header)
        const asked = Number.isFinite(seconds) ? seconds * 1000 : 2 ** attempt * 1000
        // Clamped at both ends: a negative Retry-After would otherwise retry with no backoff at all,
        // and would also make the budget check below more permissive than it looks.
        const wait = Math.min(Math.max(asked, 0), MAX_RETRY_AFTER_MS)
        if (Date.now() - startedAt + wait > RETRY_BUDGET_MS) {
          throw new GraphOfflineError(`Graph ${path} kept asking Slate to wait for more than ${RETRY_BUDGET_MS} ms`)
        }
        await this.sleep(wait)
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
    const res = await this.http.send(`/me/onenote/pages/${pageId}/content?includeIDs=true`, {}, { transfer: true })
    return res.text()
  }

  async resource(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    // The bearer token only ever goes to the configured Graph host.
    if (!url.startsWith(PUBLIC_GRAPH) && !url.startsWith(this.http.baseUrl)) {
      throw new Error(`Refusing resource outside Graph: ${new URL(url).host}`)
    }
    return this.http.bytes(url, { transfer: true })
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
