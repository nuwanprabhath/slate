import { PassThrough, Writable } from 'node:stream'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { fcParams, fcRuns, fuzzTimeout } from '../../../test/fuzz'
import { chunkings } from '../../../test/fuzzBytes'
import { LineTransport, MAX_LINE_BYTES } from './lineTransport'

type Line = { kind: 'message'; message: JSONRPCMessage } | { kind: 'garbage'; text: string }

const id = fc.oneof(fc.integer({ min: -5, max: 5 }), fc.constantFrom('1', '2', 'a', 'é', ''))
// JSON.stringify escapes newlines, so any string is safe inside a message; non-ASCII text makes chunk
// boundaries fall inside multi-byte characters.
const text = fc.string({ unit: 'binary', maxLength: 12 })

const message: fc.Arbitrary<JSONRPCMessage> = fc.oneof(
  fc.record({ id, method: fc.constantFrom('tools/call', 'ping', 'é/ü'), text }).map(({ id, method, text }) => ({ jsonrpc: '2.0' as const, id, method, params: { text } })),
  fc.record({ method: fc.constantFrom('notifications/initialized', 'notifications/€'), text }).map(({ method, text }) => ({ jsonrpc: '2.0' as const, method, params: { text } })),
  fc.record({ id, text }).map(({ id, text }) => ({ jsonrpc: '2.0' as const, id, result: { text } })),
)
// A leading '!' is never JSON, so the line is garbage whatever follows it.
const garbage = text.map((t) => '!' + t.replace(/\n/g, ''))

const line: fc.Arbitrary<Line> = fc.oneof(
  { weight: 3, arbitrary: message.map((m): Line => ({ kind: 'message', message: m })) },
  { weight: 1, arbitrary: garbage.map((t): Line => ({ kind: 'garbage', text: t })) },
)

const encode = (lines: Line[]): Uint8Array => Buffer.from(lines.map((l) => (l.kind === 'message' ? JSON.stringify(l.message) : l.text) + '\n').join(''), 'utf8')

/** A sink that never applies backpressure, so `send` never waits for a reader. */
function sink() {
  const written: Buffer[] = []
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      written.push(chunk)
      cb()
    },
  })
  const lines = () =>
    Buffer.concat(written)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JSONRPCMessage)
  return { output, lines }
}

/** Starts a transport over a PassThrough and feeds it with exact chunk boundaries (a direct 'data' emit). */
async function open() {
  const input = new PassThrough()
  const { output, lines } = sink()
  const t = new LineTransport(input, output)
  const messages: JSONRPCMessage[] = []
  const errors: Error[] = []
  let closed = false
  let afterClose = 0
  t.onmessage = (m) => {
    if (closed) afterClose++
    messages.push(m)
  }
  t.onerror = (e) => errors.push(e)
  t.onclose = () => (closed = true)
  await t.start()
  const feed = (chunk: Uint8Array) => input.emit('data', Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
  return { t, feed, messages, errors, lines, isClosed: () => closed, afterClose: () => afterClose }
}

/** Cut points as fractions, so a counterexample prints a few numbers instead of megabytes. */
// Integers in parts per million, because fc.double piles its values onto 0 and 1.
const cuts = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 16 })
function cutAt(bytes: Uint8Array, at: number[]): Uint8Array[] {
  const points = [0, ...at.map((ppm) => Math.floor((ppm / 1_000_000) * bytes.length)).sort((a, b) => a - b), bytes.length]
  return points.slice(1).map((end, i) => bytes.subarray(points[i]!, end))
}
const asLines = (ms: JSONRPCMessage[]) => Buffer.from(encode(ms.map((m): Line => ({ kind: 'message', message: m }))))

const flush = () => new Promise<void>((r) => setImmediate(r))

describe('T-F4C: LineTransport under fuzzed byte streams', () => {
  it(
    'T-F4C-01: the messages delivered are the same for every chunking, multi-byte text included',
    async () => {
      const stream = fc.array(line, { maxLength: 12 }).chain((lines) => {
        const bytes = encode(lines)
        return fc.tuple(fc.constant(lines), fc.constant(bytes), chunkings(bytes))
      })
      await fc.assert(
        fc.asyncProperty(stream, async ([lines, bytes, chunks]) => {
          const whole = await open()
          whole.feed(bytes)
          const split = await open()
          for (const c of chunks) split.feed(c)
          expect(split.messages).toEqual(whole.messages)
          expect(split.errors.length).toBe(whole.errors.length)
          // And what is delivered is what was written, in order.
          const sent = lines.flatMap((l) => (l.kind === 'message' ? [l.message] : []))
          expect(split.messages.map((m) => JSON.stringify(m))).toEqual(sent.map((m) => JSON.stringify(m)))
          expect(split.isClosed()).toBe(false)
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )

  it(
    'T-F4C-02: lines within MAX_LINE_BYTES never close the stream; a longer unterminated run always does, and nothing is delivered after it',
    async () => {
      // Line lengths around the limit, plus short messages between them. The whole stream stays under the
      // SDK ReadBuffer's 10 MiB cap: past it `append` throws inside the data handler (finding F4C-1 in
      // the task report, the same defect as T-F4C-05), so this generator keeps to one long line.
      const longLen = fc.constantFrom(MAX_LINE_BYTES - 1, MAX_LINE_BYTES, MAX_LINE_BYTES - 4096, 1)
      await fc.assert(
        fc.asyncProperty(fc.array(message, { maxLength: 3 }), longLen, fc.array(message, { maxLength: 3 }), cuts, async (before, len, after, at) => {
          const count = before.length + after.length
          const bytes = Buffer.concat([asLines(before), Buffer.alloc(len, 0x78), Buffer.from('\n'), asLines(after)])
          const s = await open()
          for (const c of cutAt(bytes, at)) s.feed(c)
          expect(s.isClosed()).toBe(false)
          expect(s.messages.length).toBe(count)
          expect(s.errors.length).toBe(1)
        }),
        fcRuns(200, 10),
      )

      await fc.assert(
        fc.asyncProperty(fc.array(message, { maxLength: 3 }), fc.integer({ min: 1, max: 64 * 1024 }), fc.array(message, { minLength: 1, maxLength: 3 }), cuts, async (before, extra, after, at) => {
          const count = before.length
          const head = Buffer.concat([asLines(before), Buffer.alloc(MAX_LINE_BYTES + extra, 0x78)])
          const tail = Buffer.concat([Buffer.from('\n'), asLines(after)])
          const s = await open()
          for (const c of cutAt(head, at)) s.feed(c)
          s.feed(tail)
          await flush()
          expect(s.isClosed()).toBe(true)
          expect(s.errors.map((e) => e.message)).toContain('message line too long')
          // Complete lines in the same chunk as the overlong tail are dropped with it (F4C-2 in the task
          // report), so what arrives is a prefix of the lines before the tail, and never anything after it.
          expect(s.messages.length).toBeLessThanOrEqual(count)
          expect(s.messages.map((m) => JSON.stringify(m))).toEqual(before.slice(0, s.messages.length).map((m) => JSON.stringify(m)))
          expect(s.afterClose()).toBe(0)
        }),
        fcRuns(200, 10),
      )
    },
    fuzzTimeout(20_000),
  )

  it(
    'T-F4C-03: each garbage line gives exactly one onerror and the valid lines after it still arrive',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(line, { maxLength: 16 }), async (lines) => {
          const s = await open()
          s.feed(encode(lines))
          expect(s.errors.length).toBe(lines.filter((l) => l.kind === 'garbage').length)
          expect(s.messages.length).toBe(lines.filter((l) => l.kind === 'message').length)
          expect(s.isClosed()).toBe(false)
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )

  type Step ={ op: 'receive'; id: string | number } | { op: 'notify' } | { op: 'answer'; id: string | number; error: boolean } | { op: 'drained' }
  const smallId = fc.constantFrom<string | number>(1, '1', 2, '2', 0, '')
  const step: fc.Arbitrary<Step> = fc.oneof(
    smallId.map((id): Step => ({ op: 'receive', id })),
    fc.constant<Step>({ op: 'notify' }),
    fc.record({ id: smallId, error: fc.boolean() }).map(({ id, error }): Step => ({ op: 'answer', id, error })),
    fc.constant<Step>({ op: 'drained' }),
  )

  it(
    'T-F4C-04: drained() resolves exactly when every request received has been answered, for any interleaving, duplicate ids and 1 vs "1"',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { maxLength: 24 }), async (steps) => {
          const s = await open()
          // The model: ids still owed an answer, compared by value and type (a Set does exactly that).
          const owed = new Set<string | number>()
          const waits: Array<{ done: boolean }> = []
          for (const st of steps) {
            if (st.op === 'receive') {
              s.feed(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: st.id, method: 'tools/call' }) + '\n'))
              owed.add(st.id)
            } else if (st.op === 'notify') {
              s.feed(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x' }) + '\n'))
            } else if (st.op === 'answer') {
              await s.t.send(st.error ? { jsonrpc: '2.0', id: st.id, error: { code: 1, message: 'x' } } : { jsonrpc: '2.0', id: st.id, result: {} })
              owed.delete(st.id)
            } else {
              const w = { done: false }
              void s.t.drained().then(() => (w.done = true))
              waits.push(w)
            }
            await flush()
            if (owed.size > 0) for (const w of waits) expect(w.done).toBe(false)
            else for (const w of waits) expect(w.done).toBe(true)
            if (owed.size === 0) waits.length = 0
          }
          for (const id of [...owed]) await s.t.send({ jsonrpc: '2.0', id, result: {} })
          await flush()
          for (const w of waits) expect(w.done).toBe(true)
          let last = false
          void s.t.drained().then(() => (last = true))
          await flush()
          expect(last).toBe(true)
        }),
        fcRuns(4, 100),
      )
    },
    fuzzTimeout(),
  )

  it(
    'T-F4C-05: after refuse(), each request gets exactly one reply and none reaches the server',
    async () => {
      const ids = fc.uniqueArray(fc.oneof(fc.integer({ min: 0, max: 50 }), fc.string({ unit: 'binary', maxLength: 4 })), {
        maxLength: 10,
        selector: (v) => JSON.stringify(v),
      })
      await fc.assert(
        fc.asyncProperty(ids, fc.array(fc.boolean(), { maxLength: 10 }), async (requestIds, notifies) => {
          const s = await open()
          s.t.refuse((m) => ({ jsonrpc: '2.0', id: (m as { id: string | number }).id, error: { code: -32603, message: 'locked' } }))
          const bytes = requestIds.map((rid, i) => JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'tools/call' }) + '\n' + (notifies[i] ? '{"jsonrpc":"2.0","method":"notifications/n"}\n' : '')).join('')
          s.feed(Buffer.from(bytes, 'utf8'))
          const replies = s.lines()
          expect(replies.map((r) => JSON.stringify((r as { id: unknown }).id)).sort()).toEqual(requestIds.map((r) => JSON.stringify(r)).sort())
          expect(s.messages.every((m) => !('id' in m))).toBe(true)
          let drained = false
          void s.t.drained().then(() => (drained = true))
          await flush()
          expect(drained).toBe(true)
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )
})
