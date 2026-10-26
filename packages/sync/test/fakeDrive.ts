import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export interface FakeDrive {
  url: string
  /** Files by path relative to the app folder. */
  files: Map<string, Uint8Array>
  offline(on: boolean): void
  close(): Promise<void>
}

interface Change {
  id: string
  path: string
  eTag: string
  deleted: boolean
  isFile: boolean
}

const APP = '/drive/root:/Apps/Slate'
const ITEM = '/me/drive/special/approot:/'
const PAGE_SIZE = 3

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The OneDrive app-folder endpoints sync uses. Delta tokens are positions in a change log, so a
 * cursor lists exactly the changes made after it, latest state per item.
 */
export async function startFakeDrive(): Promise<FakeDrive> {
  const files = new Map<string, Uint8Array>()
  const ids = new Map<string, string>()
  const log: Change[] = []
  const sessions = new Map<string, { path: string; parts: Buffer[] }>()
  const sockets = new Set<Socket>()
  let isOffline = false
  let nextId = 1
  let baseUrl = ''

  const idOf = (path: string) => {
    let id = ids.get(path)
    if (!id) ids.set(path, (id = `item-${nextId++}`))
    return id
  }

  function put(path: string, bytes: Uint8Array): void {
    const dirs = path.split('/').slice(0, -1)
    for (let i = 1; i <= dirs.length; i++) {
      const dir = dirs.slice(0, i).join('/')
      if (!ids.has(dir)) log.push({ id: idOf(dir), path: dir, eTag: 'd1', deleted: false, isFile: false })
    }
    files.set(path, bytes)
    log.push({ id: idOf(path), path, eTag: `e${log.length + 1}`, deleted: false, isFile: true })
  }

  function item(c: Change) {
    const slash = c.path.lastIndexOf('/')
    const dir = slash < 0 ? '' : '/' + c.path.slice(0, slash)
    return {
      id: c.id,
      name: c.path.slice(slash + 1),
      eTag: c.eTag,
      parentReference: { path: APP + dir },
      ...(c.deleted ? { deleted: { state: 'deleted' } } : {}),
      ...(c.isFile ? { file: { mimeType: 'application/octet-stream' }, size: files.get(c.path)?.length ?? 0 } : { folder: { childCount: 0 } })
    }
  }

  function delta(query: URLSearchParams) {
    const token = Number(query.get('token') ?? 0)
    const skip = Number(query.get('skip') ?? 0)
    const latest = new Map<string, Change>()
    for (const c of log.slice(token)) {
      latest.delete(c.id)
      latest.set(c.id, c)
    }
    const all = [...latest.values()]
    const body: Record<string, unknown> = { value: all.slice(skip, skip + PAGE_SIZE).map(item) }
    const root = `${baseUrl}/me/drive/special/approot/delta`
    if (skip + PAGE_SIZE < all.length) body['@odata.nextLink'] = `${root}?token=${token}&skip=${skip + PAGE_SIZE}`
    else body['@odata.deltaLink'] = `${root}?token=${log.length}`
    return body
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isOffline) {
      req.socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', baseUrl)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const upload = url.pathname.match(/^\/upload\/(\w+)$/)
    if (upload && req.method === 'PUT') {
      // Upload session URLs carry their own authority; Graph rejects a bearer token on them.
      const session = sessions.get(upload[1]!)
      if (!session || req.headers.authorization) return json(401, {})
      const range = String(req.headers['content-range']).match(/bytes (\d+)-(\d+)\/(\d+)/)
      session.parts.push(await readBody(req))
      if (range && Number(range[2]) + 1 === Number(range[3])) {
        put(session.path, new Uint8Array(Buffer.concat(session.parts)))
        sessions.delete(upload[1]!)
        return json(201, { id: idOf(session.path) })
      }
      return json(202, {})
    }

    if (req.headers.authorization !== 'Bearer fake-token') return json(401, { error: 'unauthorized' })

    if (url.pathname === '/me/drive/special/approot' && req.method === 'GET') {
      return json(200, { id: 'root', name: 'Slate', parentReference: { path: '/drive/root:/Apps' } })
    }
    if (url.pathname === '/me/drive/special/approot/delta' && req.method === 'GET') {
      return json(200, delta(url.searchParams))
    }
    if (url.pathname === '/me/drive/special/approot/children' && req.method === 'GET') {
      return json(200, { value: [...new Set([...files.keys()].map((p) => p.split('/')[0]!))].map((name) => ({ name })) })
    }
    const eTagOf = (path: string) => [...log].reverse().find((c) => c.path === path)?.eTag ?? ''
    if (url.pathname.startsWith(ITEM)) {
      const rest = decodeURIComponent(url.pathname.slice(ITEM.length))
      const content = rest.match(/^(.+):\/content$/)
      const session = rest.match(/^(.+):\/createUploadSession$/)
      if (content && req.method === 'PUT') {
        const exists = files.has(content[1]!)
        if (url.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail' && exists) return json(409, {})
        const ifMatch = req.headers['if-match']
        if (ifMatch !== undefined && (!exists || eTagOf(content[1]!) !== ifMatch)) return json(412, {})
        put(content[1]!, new Uint8Array(await readBody(req)))
        return json(201, { id: idOf(content[1]!) })
      }
      if (!content && !session && req.method === 'GET') {
        const bytes = files.get(rest)
        return bytes ? json(200, { id: idOf(rest), eTag: eTagOf(rest), size: bytes.length }) : json(404, {})
      }
      if (content && req.method === 'GET') {
        const bytes = files.get(content[1]!)
        if (!bytes) return json(404, {})
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.from(bytes))
        return
      }
      if (session && req.method === 'POST') {
        const id = `s${nextId++}`
        sessions.set(id, { path: session[1]!, parts: [] })
        return json(200, { uploadUrl: `${baseUrl}/upload/${id}` })
      }
      if (req.method === 'DELETE') {
        // A folder goes with everything in it.
        const gone = files.has(rest) ? [rest] : [...files.keys()].filter((p) => p.startsWith(`${rest}/`))
        if (gone.length === 0) return json(404, {})
        for (const path of gone) {
          files.delete(path)
          log.push({ id: idOf(path), path, eTag: `e${log.length + 1}`, deleted: true, isFile: true })
        }
        res.writeHead(204)
        res.end()
        return
      }
    }
    json(404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`

  return {
    url: baseUrl,
    files,
    offline(on) {
      isOffline = on
      if (on) for (const s of sockets) s.destroy()
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      })
  }
}
