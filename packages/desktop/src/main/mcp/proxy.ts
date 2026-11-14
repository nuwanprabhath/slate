import type { Duplex, Readable, Writable } from 'node:stream'
import { MAX_LINE_BYTES } from './lineTransport'

export const LOCKED_MESSAGE = 'Slate is locked or not running. Unlock Slate to give AI access.'

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { protocolVersion?: string } }

const NEWLINE = Buffer.from('\n')
const line = (m: object) => JSON.stringify(m) + '\n'

/**
 * Splits a byte stream into lines (each with its newline), in bytes so a chunk boundary inside a
 * character changes nothing. A run past `MAX_LINE_BYTES` with no newline calls `overlong` once and
 * the splitter reads nothing more; the run is never held whole, and the complete lines before it are
 * still delivered.
 */
function lineSplitter(onLine: (bytes: Buffer) => void, overlong: () => void): (chunk: Buffer) => void {
  let pending: Buffer[] = []
  let size = 0
  let stopped = false
  return (chunk) => {
    let start = 0
    while (!stopped) {
      const nl = chunk.indexOf(0x0a, start)
      const end = nl < 0 ? chunk.length : nl
      if (size + end - start > MAX_LINE_BYTES) {
        stopped = true
        pending = []
        overlong()
        return
      }
      if (nl < 0) {
        if (end > start) pending.push(chunk.subarray(start))
        size += end - start
        return
      }
      const bytes = Buffer.concat([...pending, chunk.subarray(start, nl + 1)])
      pending = []
      size = 0
      start = nl + 1
      onLine(bytes)
    }
  }
}

function parse(text: string): Message | null {
  try {
    const m = JSON.parse(text) as unknown
    return m && typeof m === 'object' ? (m as Message) : null
  } catch {
    return null
  }
}

/** §15 N5: what `slate-mcp` says for the app while it cannot reach it. */
export function lockedReply(message: object): object | null {
  const m = message as Message
  if (m.id === undefined || m.id === null || !m.method) return null
  const ok = (result: object) => ({ jsonrpc: '2.0', id: m.id, result })
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'slate', version: '0.1.0' } })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: [{ name: 'slate_status', description: LOCKED_MESSAGE, inputSchema: { type: 'object', properties: {} } }] })
    case 'tools/call':
      return ok({ isError: true, content: [{ type: 'text', text: LOCKED_MESSAGE }] })
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: LOCKED_MESSAGE } }
  }
}

/**
 * stdio ↔ the app's socket. Connected, client lines go to the app as they are and the app's bytes
 * come back untouched. Unreachable, it answers itself; on each later request it tries again and, on
 * a new connection, replays the client's `initialize` (+ `notifications/initialized`) and swallows
 * the app's answer, since the client already had one. The client is then told the tool list changed.
 */
export function runProxy(opts: { input: Readable; output: Writable; connect: () => Promise<Duplex> }): Promise<void> {
  const { input, output, connect } = opts
  let socket: Duplex | null = null
  let initLine: Buffer | null = null
  let queue = Promise.resolve()
  // Requests the app has not answered: a lock can close the socket after reading one, and the
  // client would otherwise wait on it forever.
  const unanswered = new Map<string, Message>()
  const key = (id: Message['id']) => JSON.stringify(id)

  const attach = async (replay: boolean): Promise<boolean> => {
    let s: Duplex
    try {
      s = await connect()
    } catch {
      return false
    }
    const initId = replay && initLine ? parse(initLine.toString('utf8'))?.id : undefined
    let swallowing = initId !== undefined
    // An overlong app line drops the connection, as a lock does: what the app owed gets lockedReply.
    s.on(
      'data',
      lineSplitter(
        (bytes) => {
          const m = parse(bytes.toString('utf8'))
          if (swallowing) {
            if (m && m.id === initId && m.method === undefined) swallowing = false
            return
          }
          if (m && m.method === undefined && m.id !== undefined) unanswered.delete(key(m.id))
          output.write(bytes)
        },
        () => s.destroy(),
      ),
    )
    const dropped = () => {
      if (socket !== s) return
      socket = null
      for (const m of unanswered.values()) {
        const reply = lockedReply(m)
        if (reply) output.write(line(reply))
      }
      unanswered.clear()
      output.write(line({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    }
    s.on('close', dropped)
    s.on('error', () => s.destroy())
    socket = s
    if (initId !== undefined) {
      s.write(initLine!)
      s.write(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      output.write(line({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    }
    return true
  }

  // `bytes` is one client line without its newline; only the parse sees it as text.
  const handle = async (bytes: Buffer) => {
    const m = parse(bytes.toString('utf8'))
    const isInit = m?.method === 'initialize'
    if (isInit) initLine = Buffer.concat([bytes, NEWLINE])
    if (!socket && m && (isInit || (initLine && m.id !== undefined))) await attach(!isInit)
    if (socket) {
      if (m && m.method && m.id !== undefined && m.id !== null) unanswered.set(key(m.id), m)
      socket.write(Buffer.concat([bytes, NEWLINE]))
      return
    }
    const reply = m && lockedReply(m)
    if (reply) output.write(line(reply))
  }

  return new Promise((resolve) => {
    const finish = () =>
      void queue.then(() => {
        socket?.end()
        resolve()
      })
    const onData = lineSplitter(
      (withNewline) => {
        const nl = withNewline.length - 1
        const end = nl > 0 && withNewline[nl - 1] === 0x0d ? nl - 1 : nl
        const bytes = withNewline.subarray(0, end)
        if (bytes.toString('utf8').trim()) queue = queue.then(() => handle(bytes))
      },
      // An overlong client line ends the session, as the app's transport closes its connection.
      () => {
        input.off('data', onData)
        input.off('end', finish)
        input.destroy()
        finish()
      },
    )
    input.on('data', onData)
    input.on('end', finish)
  })
}
