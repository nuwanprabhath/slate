import type { Duplex, Readable, Writable } from 'node:stream'

export const LOCKED_MESSAGE = 'Slate is locked or not running. Unlock Slate to give AI access.'

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { protocolVersion?: string } }

const line = (m: object) => JSON.stringify(m) + '\n'

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
  let initLine: string | null = null
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
    const initId = replay && initLine ? parse(initLine)?.id : undefined
    let swallowing = initId !== undefined
    let pending = ''
    s.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let nl: number
      while ((nl = pending.indexOf('\n')) >= 0) {
        const text = pending.slice(0, nl + 1)
        pending = pending.slice(nl + 1)
        const m = parse(text)
        if (swallowing) {
          if (m && m.id === initId && m.method === undefined) swallowing = false
          continue
        }
        if (m && m.method === undefined && m.id !== undefined) unanswered.delete(key(m.id))
        output.write(text)
      }
    })
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
      s.write(initLine!.endsWith('\n') ? initLine! : initLine + '\n')
      s.write(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      output.write(line({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    }
    return true
  }

  const handle = async (text: string) => {
    const m = parse(text)
    const isInit = m?.method === 'initialize'
    if (isInit) initLine = text
    if (!socket && m && (isInit || (initLine && m.id !== undefined))) await attach(!isInit)
    if (socket) {
      if (m && m.method && m.id !== undefined && m.id !== null) unanswered.set(key(m.id), m)
      socket.write(text + '\n')
      return
    }
    const reply = m && lockedReply(m)
    if (reply) output.write(line(reply))
  }

  return new Promise((resolve) => {
    let buffered = ''
    input.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, nl).replace(/\r$/, '')
        buffered = buffered.slice(nl + 1)
        if (text.trim()) queue = queue.then(() => handle(text))
      }
    })
    input.on('end', () => {
      void queue.then(() => {
        socket?.end()
        resolve()
      })
    })
  })
}
