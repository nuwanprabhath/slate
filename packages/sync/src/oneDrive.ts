import { GraphError, type GraphHttp } from '@slate/importer'
import { OfflineError, type DeltaPage, type RemoteDrive, type RemoteItem } from './types'

const APPROOT = '/me/drive/special/approot'
// Graph's simple upload takes at most 4 MB; session ranges must be multiples of 320 KiB.
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK = 320 * 1024 * 12

interface DriveItem {
  id: string
  name?: string
  eTag?: string
  deleted?: unknown
  file?: unknown
  size?: number
  parentReference?: { path?: string }
}

export interface OneDriveOptions {
  /** Injected for tests; upload session URLs are fetched without the bearer token. */
  fetch?: typeof fetch
  simpleUploadLimit?: number
  uploadChunkSize?: number
}

const itemPath = (path: string) => `${APPROOT}:/${path.split('/').map(encodeURIComponent).join('/')}`

/** Fetch rejects (rather than resolving with a status) only when the network failed. */
async function offlineOnNetworkError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof TypeError) throw new OfflineError(err.message, { cause: err })
    throw err
  }
}

/** The Slate app folder in the user's OneDrive (`/Apps/Slate`). */
export class OneDriveClient implements RemoteDrive {
  private rootPath: string | undefined
  private readonly doFetch: typeof fetch
  private readonly simpleUploadLimit: number
  private readonly uploadChunkSize: number

  constructor(
    private readonly http: GraphHttp,
    opts: OneDriveOptions = {}
  ) {
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.simpleUploadLimit = opts.simpleUploadLimit ?? SIMPLE_UPLOAD_LIMIT
    this.uploadChunkSize = opts.uploadChunkSize ?? UPLOAD_CHUNK
  }

  upload(path: string, bytes: Uint8Array): Promise<void> {
    return offlineOnNetworkError(async () => {
      if (bytes.length <= this.simpleUploadLimit) {
        await this.http.send(`${itemPath(path)}:/content`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          // A copy is backed by a plain ArrayBuffer, which BodyInit requires.
          body: bytes.slice()
        })
        return
      }
      const session = await this.http.json<{ uploadUrl: string }>(`${itemPath(path)}:/createUploadSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
      })
      for (let start = 0; start < bytes.length; start += this.uploadChunkSize) {
        const end = Math.min(start + this.uploadChunkSize, bytes.length)
        const res = await this.doFetch(session.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
          body: bytes.slice(start, end)
        })
        if (!res.ok) throw new GraphError(res.status, 'uploadSession')
      }
    })
  }

  download(path: string): Promise<Uint8Array> {
    return offlineOnNetworkError(async () => (await this.http.bytes(`${itemPath(path)}:/content`)).bytes)
  }

  remove(path: string): Promise<void> {
    return offlineOnNetworkError(async () => {
      try {
        await this.http.send(itemPath(path), { method: 'DELETE' })
      } catch (err) {
        // Already gone is what we wanted.
        if (!(err instanceof GraphError && err.status === 404)) throw err
      }
    })
  }

  delta(cursor: string | null): Promise<DeltaPage> {
    return offlineOnNetworkError(async () => {
      const root = await this.root()
      const items: RemoteItem[] = []
      let next = cursor ?? `${APPROOT}/delta`
      for (;;) {
        const body = await this.http.json<{ value: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(next)
        for (const it of body.value) items.push(toItem(it, root))
        if (body['@odata.nextLink']) next = body['@odata.nextLink']
        else if (body['@odata.deltaLink']) return { items, cursor: body['@odata.deltaLink'] }
        else throw new Error('Graph delta returned neither nextLink nor deltaLink')
      }
    })
  }

  /** The app folder's own path, as items' `parentReference.path` spells it. */
  private async root(): Promise<string> {
    if (this.rootPath === undefined) {
      const me = await this.http.json<{ name: string; parentReference?: { path?: string } }>(APPROOT)
      this.rootPath = `${me.parentReference?.path ?? ''}/${me.name}`
    }
    return this.rootPath
  }
}

function toItem(it: DriveItem, root: string): RemoteItem {
  const parent = it.parentReference?.path
  let path = ''
  if (parent === root) path = it.name ?? ''
  else if (parent?.startsWith(root + '/')) path = `${parent.slice(root.length + 1)}/${it.name ?? ''}`
  return {
    id: it.id,
    path: decodeURIComponent(path),
    eTag: it.eTag ?? '',
    deleted: it.deleted !== undefined,
    isFile: it.file !== undefined || (it.deleted !== undefined && it.name?.includes('.') === true),
    ...(typeof it.size === 'number' ? { size: it.size } : {})
  }
}
