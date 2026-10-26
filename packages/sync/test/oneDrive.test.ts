import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphHttp } from '@slate/importer'
import { OneDriveClient } from '../src/oneDrive'
import { OfflineError } from '../src/types'
import { startFakeDrive, type FakeDrive } from './fakeDrive'

let drive: FakeDrive
let client: OneDriveClient

const bytes = (...xs: number[]) => new Uint8Array(xs)

beforeEach(async () => {
  drive = await startFakeDrive()
  client = new OneDriveClient(new GraphHttp({ baseUrl: drive.url, getToken: async () => 'fake-token', maxRetries: 0 }))
})

afterEach(() => drive.close())

describe('OneDriveClient', () => {
  it('uploads and downloads the same bytes', async () => {
    await client.upload('docs/page_x/dev1/00000001.chunk', bytes(1, 2, 3))
    expect(drive.files.get('docs/page_x/dev1/00000001.chunk')).toEqual(bytes(1, 2, 3))
    expect(await client.download('docs/page_x/dev1/00000001.chunk')).toEqual(bytes(1, 2, 3))
  })

  it('uploads large files through an upload session', async () => {
    const big = new OneDriveClient(new GraphHttp({ baseUrl: drive.url, getToken: async () => 'fake-token' }), {
      simpleUploadLimit: 10,
      uploadChunkSize: 4
    })
    const data = Uint8Array.from({ length: 23 }, (_, i) => i)
    await big.upload('blobs/big.png', data)
    expect(await big.download('blobs/big.png')).toEqual(data)
  })

  it('lists every file from scratch with app-folder relative paths', async () => {
    await client.upload('docs/page_x/dev1/00000001.chunk', bytes(1))
    await client.upload('docs/page_x/dev1/00000002.chunk', bytes(2))
    await client.upload('blobs/a.png', bytes(3))
    await client.upload('devices/dev1.json', bytes(4))
    const page = await client.delta(null)
    const files = page.items.filter((i) => i.isFile).map((i) => i.path)
    expect(files.sort()).toEqual(['blobs/a.png', 'devices/dev1.json', 'docs/page_x/dev1/00000001.chunk', 'docs/page_x/dev1/00000002.chunk'])
    expect(page.items.find((i) => !i.isFile)?.path).toBeTruthy()
    expect(page.items.every((i) => i.id !== '' && i.eTag !== '' && !i.deleted)).toBe(true)
  })

  it('reports each file size from the delta item', async () => {
    await client.upload('blobs/a.png', new Uint8Array(321))
    const page = await client.delta(null)
    expect(page.items.find((i) => i.path === 'blobs/a.png')?.size).toBe(321)
  })

  it('lists only later changes from a returned cursor', async () => {
    await client.upload('docs/page_x/dev1/00000001.chunk', bytes(1))
    const first = await client.delta(null)
    await client.upload('docs/page_x/dev1/00000002.chunk', bytes(2))
    const second = await client.delta(first.cursor)
    expect(second.items.map((i) => i.path)).toEqual(['docs/page_x/dev1/00000002.chunk'])
    expect((await client.delta(second.cursor)).items).toEqual([])
  })

  it('reports removed files as deleted', async () => {
    await client.upload('docs/page_x/dev1/00000001.chunk', bytes(1))
    const first = await client.delta(null)
    await client.remove('docs/page_x/dev1/00000001.chunk')
    const second = await client.delta(first.cursor)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]).toMatchObject({ path: 'docs/page_x/dev1/00000001.chunk', deleted: true })
    expect(drive.files.has('docs/page_x/dev1/00000001.chunk')).toBe(false)
  })

  it('rejects with an OfflineError when the network is down', async () => {
    drive.offline(true)
    const err = await client.delta(null).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfflineError)
    expect((err as OfflineError).offline).toBe(true)
    await expect(client.upload('x', bytes(1))).rejects.toBeInstanceOf(OfflineError)
    drive.offline(false)
    expect((await client.delta(null)).items).toEqual([])
  })
})
