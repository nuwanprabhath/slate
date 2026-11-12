import { Duplex, PassThrough, Writable } from 'node:stream'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fcParams, fcRuns, fuzzTimeout } from '../../../test/fuzz'
import { chunkings } from '../../../test/fuzzBytes'
import { runProxy } from './proxy'

type Id = string | number
type Msg = { id?: Id | null; method?: string; result?: unknown; error?: unknown }

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

/** Collects every byte the proxy writes to the client. */
function client() {
  const written: Buffer[] = []
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      written.push(Buffer.from(chunk))
      cb()
    },
  })
  const bytes = () => Buffer.concat(written)
  const messages = () =>
    bytes()
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Msg)
  return { output, bytes, messages }
}

/**
 * A stand-in for the app's socket. It answers `initialize` at once (as the real server does), keeps every
 * other request until the model says `answer`, and records the raw bytes it was sent.
 */
function fakeApp() {
  const received: Buffer[] = []
  const outstanding: Id[] = []
  let buffered = ''
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      received.push(Buffer.from(chunk))
      buffered += chunk.toString('utf8')
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let m: Msg
        try {
          m = JSON.parse(text) as Msg
        } catch {
          continue
        }
        if (m.method === 'initialize' && m.id !== undefined && m.id !== null) {
          const reply = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'app', version: '1' } } }) + '\n'
          queueMicrotask(() => socket.emit('data', Buffer.from(reply)))
        } else if (m.method && m.id !== undefined && m.id !== null) outstanding.push(m.id)
      }
      cb()
    },
  })
  const answer = () => {
    // A destroyed socket delivers nothing more.
    const id = socket.destroyed ? undefined : outstanding.shift()
    if (id === undefined) return
    socket.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { from: 'app' } }) + '\n'))
  }
  return { socket, received, answer }
}

type Cmd = { op: 'request'; method: string } | { op: 'notify' } | { op: 'answer' } | { op: 'drop' }

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('tools/call', 'tools/list', 'ping', 'resources/list').map((method): Cmd => ({ op: 'request', method })) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ op: 'notify' }) },
  { weight: 3, arbitrary: fc.constant<Cmd>({ op: 'answer' }) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ op: 'drop' }) },
)

/** Ids 1, "1", 2, "2", ...: unique per request, with pairs that differ only by type. */
const idAt = (i: number): Id => (i % 2 === 0 ? i / 2 + 1 : String((i - 1) / 2 + 1))

describe('T-F4C: the MCP proxy under fuzzed connection schedules', () => {
  it(
    'T-F4C-06: every client request with an id gets exactly one response, the app\'s or lockedReply\'s; initialize is answered once',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 12 }), fc.array(cmd, { maxLength: 30 }), async (connects, cmds) => {
          // Each connect() takes the next outcome; past the schedule it succeeds.
          const outcomes = [...connects]
          let current: ReturnType<typeof fakeApp> | null = null
          const connect = async (): Promise<Duplex> => {
            if (outcomes.shift() === false) throw new Error('ECONNREFUSED')
            current = fakeApp()
            return current.socket
          }
          const input = new PassThrough()
          const out = client()
          const done = runProxy({ input, output: out.output, connect })
          const send = (m: object) => input.write(JSON.stringify(m) + '\n')
          const requested: Id[] = ['init']
          send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18' } })
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          await settle()
          let n = 0
          for (const c of cmds) {
            if (c.op === 'request') {
              const id = idAt(n++)
              requested.push(id)
              send({ jsonrpc: '2.0', id, method: c.method, params: {} })
            } else if (c.op === 'notify') send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })
            else if (c.op === 'answer') current?.answer()
            else current?.socket.destroy()
            await settle()
          }
          // The app goes away for good: whatever it still owed is answered by lockedReply.
          current?.socket.destroy()
          await settle()
          input.end()
          await done

          const responses = out.messages().filter((m) => m.method === undefined)
          for (const id of requested) {
            const count = responses.filter((r) => r.id === id).length
            expect(count, `responses to ${JSON.stringify(id)}`).toBe(1)
          }
          expect(responses.length).toBe(requested.length)
        }),
        fcRuns(4, 100),
      )
    },
    fuzzTimeout(20_000),
  )

  // Client lines: any bytes except a newline, not blank, and not ending in CR (the proxy reads CRLF as LF,
  // which is framing, not content). Not JSON is fine: a connected proxy forwards what it does not parse.
  const clientLine = fc
    .uint8Array({ minLength: 1, maxLength: 40 })
    .map((b) => Buffer.from(b.map((x) => (x === 0x0a ? 0x41 : x))))
    .filter((b) => b[b.length - 1] !== 0x0d && b.toString('utf8').trim() !== '')
  const textLine = fc.string({ unit: 'binary', minLength: 1, maxLength: 20 }).map((t) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { t } }), 'utf8'))
  const appLine = fc.oneof(
    fc.uint8Array({ maxLength: 40 }).map((b) => Buffer.from(b.map((x) => (x === 0x0a ? 0x41 : x)))),
    fc.string({ unit: 'binary', maxLength: 20 }).map((t) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { t } }), 'utf8')),
  )
  const joined = (lines: Buffer[]) => Buffer.concat(lines.flatMap((l) => [l, Buffer.from('\n')]))
  const INIT = Buffer.from('{"jsonrpc":"2.0","id":"init","method":"initialize","params":{}}\n')

  it(
    'T-F4C-07: runProxy relays every line byte for byte, both ways, under any chunking',
    async () => {
      const streams = fc
        .tuple(fc.array(fc.oneof(clientLine, textLine), { maxLength: 8 }), fc.array(appLine, { maxLength: 8 }))
        .chain(([up, down]) => {
          const upBytes = joined(up)
          const downBytes = joined(down)
          return fc.tuple(fc.constant(upBytes), chunkings(upBytes), fc.constant(downBytes), chunkings(downBytes))
        })
      await fc.assert(
        fc.asyncProperty(streams, async ([upBytes, upChunks, downBytes, downChunks]) => {
          const app = fakeApp()
          const input = new PassThrough()
          const out = client()
          const done = runProxy({ input, output: out.output, connect: async () => app.socket })
          input.emit('data', INIT)
          await settle()
          const afterInit = out.bytes().length
          for (const c of upChunks) input.emit('data', Buffer.from(c))
          await settle()
          for (const c of downChunks) app.socket.emit('data', Buffer.from(c))
          await settle()
          // Compared as hex, so a failure shows which bytes changed (a replacement character is efbfbd).
          expect(Buffer.concat(app.received).toString('hex')).toBe(Buffer.concat([INIT, upBytes]).toString('hex'))
          expect(out.bytes().subarray(afterInit).toString('hex')).toBe(downBytes.toString('hex'))
          input.end()
          await done
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )
})
