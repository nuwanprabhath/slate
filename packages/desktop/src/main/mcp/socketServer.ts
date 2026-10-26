import { rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { createSlateMcpServer, type DocSource } from '@slate/mcp'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { LineTransport } from './lineTransport'
import { lockedReply } from './proxy'

export interface McpSocketServer {
  /** Stops accepting, lets requests already received finish (up to `graceMs`), then drops every client. */
  close(graceMs?: number): Promise<void>
}

const GRACE_MS = 5000

/**
 * §9: the MCP tools inside the app, one server instance per connection, over the app's own
 * DocSource, so permission checks and audit rows are the app's and a client never touches the store.
 */
export async function startMcpSocketServer(path: string, source: DocSource): Promise<McpSocketServer> {
  // A socket left by a crash would make listen fail with EADDRINUSE.
  rmSync(path, { force: true })
  const clients = new Map<Socket, LineTransport>()
  const server = createServer((socket) => {
    const transport = new LineTransport(socket, socket)
    clients.set(socket, transport)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => socket.destroy())
    void createSlateMcpServer(source)
      .connect(transport)
      .catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  let closing: Promise<void> | null = null
  return {
    close: (graceMs = GRACE_MS) =>
      (closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        const all = [...clients.values()]
        for (const t of all) t.refuse((m) => lockedReply(m) as JSONRPCMessage | null)
        await Promise.race([Promise.all(all.map((t) => t.drained())), new Promise((r) => setTimeout(r, graceMs).unref())])
        // Every socket is fully closed before this resolves: a pipe handle still closing when the
        // app quits makes Electron segfault in node::AsyncWrap's destructor.
        await Promise.all(
          [...clients].map(async ([socket, transport]) => {
            const closed = new Promise<void>((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())))
            await transport.close()
            // end() flushes the last response; destroy() covers a client that never reads it.
            socket.end()
            const timer = setTimeout(() => socket.destroy(), 1000)
            await closed
            clearTimeout(timer)
          }),
        )
        await stopped
        rmSync(path, { force: true })
      })()),
  }
}
