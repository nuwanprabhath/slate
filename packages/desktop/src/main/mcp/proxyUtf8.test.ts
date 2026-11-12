import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runProxy } from './proxy'

const tick = () => new Promise((r) => setTimeout(r, 20))

/** A stand-in for the app's socket: `received` is what the proxy wrote, `socket.push` is the app speaking. */
function fakeApp() {
  const received: Buffer[] = []
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      received.push(chunk)
      cb()
    },
  })
  return { socket, received }
}

/** Splits `bytes` in the middle of the first multi-byte character. */
function splitInside(bytes: Buffer): [Buffer, Buffer] {
  const at = bytes.findIndex((b) => b >= 0xc0) + 1
  return [bytes.subarray(0, at), bytes.subarray(at)]
}

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'

describe('T-FX5: the MCP proxy relays bytes', () => {
  it('T-FX5-01: a reply holding 5€ split inside the character arrives byte for byte', async () => {
    const { socket } = fakeApp()
    const input = new PassThrough()
    const output = new PassThrough()
    const out: Buffer[] = []
    output.on('data', (c: Buffer) => out.push(c))
    void runProxy({ input, output, connect: async () => socket })
    input.write(INIT)
    await tick()
    const reply = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"text":"5€"}}\n', 'utf8')
    const [a, b] = splitInside(reply)
    socket.push(a)
    await tick()
    socket.push(b)
    await tick()
    expect(Buffer.concat(out).equals(reply)).toBe(true)
  })

  it('T-FX5-02: a request holding café split inside the character is forwarded byte for byte', async () => {
    const { socket, received } = fakeApp()
    const input = new PassThrough()
    const output = new PassThrough()
    void runProxy({ input, output, connect: async () => socket })
    input.write(INIT)
    await tick()
    const req = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"q":"café"}}\n', 'utf8')
    const [a, b] = splitInside(req)
    input.write(a)
    await tick()
    input.write(b)
    await tick()
    expect(Buffer.concat(received).equals(Buffer.concat([Buffer.from(INIT), req]))).toBe(true)
  })
})
