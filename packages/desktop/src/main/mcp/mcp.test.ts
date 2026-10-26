import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { NotebookDoc } from '@slate/core'
import { DocStore } from '../store'
import { storeDocSource } from './docSource'
import { LineTransport } from './lineTransport'
import { LOCKED_MESSAGE, runProxy } from './proxy'
import { checkSocketDir, mcpSocketPath, prepareSocketDir, socketEnv } from './socketPath'
import { startMcpSocketServer, type McpSocketServer } from './socketServer'

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '')
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'slate-mcp-'))
}

/** A store with notebook "Work": "Shared" readwrite, "Reference" read-only, "Private" not shared. */
function seededStore(dir: string) {
  const store = new DocStore(join(dir, 'slate.db'))
  const nb = NotebookDoc.create('Work')
  const shared = nb.addSection('Shared')
  const reference = nb.addSection('Reference')
  const priv = nb.addSection('Private')
  const refPage = nb.addPage(reference, 'Handbook')
  nb.addPage(priv, 'Diary')
  nb.setAccess(shared as never, 'readwrite')
  nb.setAccess(reference as never, 'read')
  store.append('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
  const hidden = NotebookDoc.create('Secret')
  hidden.addSection('Nope')
  store.append('notebook:nb2', hidden.doc.export({ mode: 'snapshot' }))
  cleanups.push(() => store.close())
  return { store, shared, refPage }
}

const socketConnect = (path: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = connect(path)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })

async function clientOver(input: PassThrough | Socket, output: PassThrough | Socket): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new LineTransport(input, output))
  cleanups.push(() => client.close())
  return client
}

describe('socket path (§9)', () => {
  it('uses <userData>/mcp.sock when it fits in 100 bytes, else $TMPDIR/slate-<uid>/mcp.sock', () => {
    expect(mcpSocketPath('/home/a/.config/Slate', { tmpdir: '/tmp', uid: 501 })).toBe('/home/a/.config/Slate/mcp.sock')
    const long = '/home/' + 'x'.repeat(100)
    expect(mcpSocketPath(long, { tmpdir: '/tmp', uid: 501 })).toBe('/tmp/slate-501/mcp.sock')
  })

  it('makes the data folder 0700 and creates the temp folder 0700', () => {
    const dir = dataDir()
    chmodSync(dir, 0o755)
    const sock = join(dir, 'tmp', `slate-${process.getuid!()}`, 'mcp.sock')
    prepareSocketDir(sock, dir, process.getuid!())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(sock, '..')).mode & 0o777).toBe(0o700)
  })

  it('refuses a temp folder other users can read, or one owned by someone else', () => {
    const dir = dataDir()
    const open = join(dir, 'slate-x')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    expect(() => prepareSocketDir(join(open, 'mcp.sock'), dir, process.getuid!())).toThrow(/other users/)
    chmodSync(open, 0o700)
    expect(() => prepareSocketDir(join(open, 'mcp.sock'), dir, process.getuid!() + 1)).toThrow(/someone else/)
  })

  it('prefers $XDG_RUNTIME_DIR over the temp dir when it is set', () => {
    const long = '/home/' + 'x'.repeat(100)
    expect(mcpSocketPath(long, { tmpdir: '/tmp', uid: 501, runtimeDir: '/run/user/501' })).toBe('/run/user/501/slate-501/mcp.sock')
    expect(socketEnv({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/7' }, tmpdir: '/tmp', uid: 7 })).toEqual({ tmpdir: '/tmp', uid: 7, runtimeDir: '/run/user/7' })
    expect(socketEnv({ platform: 'darwin', env: { XDG_RUNTIME_DIR: '/run/user/7' }, tmpdir: '/tmp', uid: 7 })).toEqual({ tmpdir: '/tmp', uid: 7 })
  })

  it('the proxy checks a temp socket folder before connecting, and never creates one', () => {
    const dir = dataDir()
    const open = join(dir, 'slate-y')
    expect(() => checkSocketDir(join(open, 'mcp.sock'), dir, process.getuid!())).toThrow()
    expect(existsSync(open)).toBe(false)
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    expect(() => checkSocketDir(join(open, 'mcp.sock'), dir, process.getuid!())).toThrow(/other users/)
    chmodSync(open, 0o700)
    expect(() => checkSocketDir(join(open, 'mcp.sock'), dir, process.getuid!() + 1)).toThrow(/someone else/)
    expect(() => checkSocketDir(join(open, 'mcp.sock'), dir, process.getuid!())).not.toThrow()
    const link = join(dir, 'slate-link')
    symlinkSync(open, link)
    expect(() => checkSocketDir(join(link, 'mcp.sock'), dir, process.getuid!())).toThrow(/not a directory/)
    // The data folder itself needs no check here: the app made it 0700.
    expect(() => checkSocketDir(join(dir, 'mcp.sock'), dir, process.getuid!())).not.toThrow()
  })
})

describe('MCP inside the app (§9)', () => {
  async function serve(dir: string, store: DocStore, saved: string[] = []): Promise<{ path: string; server: McpSocketServer }> {
    const path = join(dir, 'mcp.sock')
    const server = await startMcpSocketServer(path, storeDocSource(() => store, (docId) => saved.push(docId)))
    cleanups.push(() => server.close(100))
    return { path, server }
  }

  it('lists only shared notebooks, refuses writes to read-only ones, writes audit rows and reports saves', async () => {
    const dir = dataDir()
    const { store, shared, refPage } = seededStore(dir)
    const saved: string[] = []
    const { path } = await serve(dir, store, saved)
    const sock = await socketConnect(path)
    const client = await clientOver(sock, sock)

    const tree = JSON.parse(textOf(await client.callTool({ name: 'list_tree', arguments: {} }))) as Array<{ name: string; items: Array<{ title: string }> }>
    expect(tree.map((n) => n.name)).toEqual(['Work'])
    expect(tree[0]!.items.map((i) => i.title).sort()).toEqual(['Reference', 'Shared'])

    const refused = await client.callTool({ name: 'append_to_page', arguments: { pageId: refPage.pageId, markdown: 'hi' } })
    expect(refused.isError).toBe(true)
    expect(saved).toEqual([])

    const created = await client.callTool({ name: 'create_page', arguments: { notebookId: 'nb1', sectionId: shared, title: 'From AI', markdown: 'hello' } })
    expect(created.isError).toBeFalsy()
    expect(saved).toContain('notebook:nb1')

    const audit = store.listAudit().map((r) => `${r.tool}:${r.outcome}`)
    expect(audit).toContain('append_to_page:denied')
    expect(audit).toContain('create_page:ok')
  })

  it('a stale socket file does not stop it starting, and close lets an in-flight request finish', async () => {
    const dir = dataDir()
    const { store } = seededStore(dir)
    const path = join(dir, 'mcp.sock')
    // A crashed app leaves its socket file behind.
    const crashed = await startMcpSocketServer(path, storeDocSource(() => store))
    cleanups.push(() => crashed.close(0))
    const base = storeDocSource(() => store)
    let started!: () => void
    const inTool = new Promise<void>((r) => (started = r))
    const slow = {
      ...base,
      notebooks: async () => {
        started()
        await new Promise((r) => setTimeout(r, 100))
        return base.notebooks()
      },
    }
    const server = await startMcpSocketServer(path, slow)
    const sock = await socketConnect(path)
    const client = await clientOver(sock, sock)
    const call = client.callTool({ name: 'list_tree', arguments: {} })
    await inTool
    const closed = server.close()
    // A request arriving while the lock waits is answered, never left hanging.
    const late = await client.callTool({ name: 'list_tree', arguments: {} })
    expect(late.isError).toBe(true)
    expect(textOf(late)).toBe(LOCKED_MESSAGE)
    expect(textOf(await call)).toContain('Work')
    await closed
    await expect(socketConnect(path)).rejects.toThrow()
  })
})

describe('slate-mcp proxy (§15 N5)', () => {
  it('answers while locked, reconnects with a replayed initialize, and survives a lock mid-session', async () => {
    const dir = dataDir()
    const { store } = seededStore(dir)
    const path = join(dir, 'mcp.sock')
    const toProxy = new PassThrough()
    const fromProxy = new PassThrough()
    void runProxy({ input: toProxy, output: fromProxy, connect: () => socketConnect(path) })
    cleanups.push(() => toProxy.end())
    const client = await clientOver(fromProxy, toProxy)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['slate_status'])
    expect(tools[0]!.description).toBe(LOCKED_MESSAGE)
    const locked = await client.callTool({ name: 'list_tree', arguments: {} })
    expect(locked.isError).toBe(true)
    expect(textOf(locked)).toBe(LOCKED_MESSAGE)

    let server = await startMcpSocketServer(path, storeDocSource(() => store))
    const open = await client.callTool({ name: 'list_tree', arguments: {} })
    expect(open.isError).toBeFalsy()
    expect(textOf(open)).toContain('Work')
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('read_page')

    await server.close()
    const again = await client.callTool({ name: 'list_tree', arguments: {} })
    expect(again.isError).toBe(true)
    expect(textOf(again)).toBe(LOCKED_MESSAGE)

    server = await startMcpSocketServer(path, storeDocSource(() => store))
    cleanups.push(() => server.close(100))
    expect(textOf(await client.callTool({ name: 'list_tree', arguments: {} }))).toContain('Work')
    expect(store.listAudit().filter((r) => r.tool === 'list_tree').length).toBeGreaterThanOrEqual(2)
  })

  it('answers a request the app dropped unanswered when its socket closed (a lock racing the call)', async () => {
    const path = join(dataDir(), 'mcp.sock')
    // An app that is locking: it reads the call and closes without replying.
    const app = createServer((s) => {
      let buf = ''
      s.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        for (let nl: number; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) {
          const m = JSON.parse(buf.slice(0, nl)) as { id?: number; method: string; params?: { protocolVersion?: string } }
          if (m.method === 'initialize') s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } }) + '\n')
          if (m.method === 'tools/call') s.destroy()
        }
      })
    })
    await new Promise<void>((r) => app.listen(path, r))
    cleanups.push(() => new Promise((r) => app.close(r)))
    const toProxy = new PassThrough()
    const fromProxy = new PassThrough()
    void runProxy({ input: toProxy, output: fromProxy, connect: () => socketConnect(path) })
    cleanups.push(() => toProxy.end())
    const client = await clientOver(fromProxy, toProxy)

    const r = await client.callTool({ name: 'list_tree', arguments: {} }, undefined, { timeout: 3000 })
    expect(textOf(r)).toBe(LOCKED_MESSAGE)
  })
})
