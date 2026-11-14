import type { Readable, Writable } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Newline-delimited JSON-RPC over any byte stream pair, framed exactly as the stdio transport
 * frames it, so `slate-mcp` can relay bytes between the two without parsing them. It counts
 * requests still waiting for their response, so the app can let them finish before it locks.
 */
/** A client that never sends a newline would grow the buffer without end; 8 MiB is past any real message. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

export class LineTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private readonly pending = new Set<string | number>()
  private idle: Array<() => void> = []
  private closed = false
  private unterminated = 0
  private refusing: ((request: JSONRPCMessage) => JSONRPCMessage | null) | null = null

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  async start(): Promise<void> {
    this.input.on('data', this.onData)
    this.input.on('error', this.onError)
    this.input.on('close', this.onEnd)
    this.input.on('end', this.onEnd)
  }

  // One line at a time reaches the SDK's ReadBuffer, each checked before it is appended, so Slate's
  // limit decides and the buffer's own 10 MiB cap (which throws) is never reached; the complete lines
  // before an overlong run are delivered whatever the chunking.
  private readonly onData = (chunk: Buffer) => {
    let start = 0
    while (start < chunk.length && !this.closed) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline < 0 ? chunk.length : newline
      const length = this.unterminated + end - start
      if (length > MAX_LINE_BYTES) return this.fail(new Error('message line too long'))
      const next = newline < 0 ? chunk.length : newline + 1
      try {
        this.buffer.append(chunk.subarray(start, next))
      } catch (e) {
        return this.fail(e as Error)
      }
      start = next
      if (newline < 0) {
        this.unterminated = length
        return
      }
      this.unterminated = 0
      this.readLines()
    }
  }

  private fail(error: Error) {
    this.onerror?.(error)
    this.input.destroy()
    void this.close()
  }

  private readLines() {
    for (;;) {
      let message: JSONRPCMessage | null
      try {
        message = this.buffer.readMessage()
      } catch (e) {
        this.onerror?.(e as Error)
        continue
      }
      if (!message) break
      if (this.refusing && 'method' in message && 'id' in message) {
        const reply = this.refusing(message)
        if (reply) this.output.write(serializeMessage(reply))
        continue
      }
      if ('method' in message && 'id' in message) this.pending.add(message.id)
      this.onmessage?.(message)
    }
  }

  private readonly onError = (e: Error) => this.onerror?.(e)
  private readonly onEnd = () => void this.close()

  /**
   * From now on requests are answered with `reply` instead of reaching the server: one that
   * arrives while the app locks must still get an answer, or the client waits for ever.
   */
  refuse(reply: (request: JSONRPCMessage) => JSONRPCMessage | null): void {
    this.refusing = reply
  }

  /** Resolves once every request received so far has been answered (or the stream is gone). */
  drained(): Promise<void> {
    if (this.pending.size === 0 || this.closed) return Promise.resolve()
    return new Promise((resolve) => this.idle.push(resolve))
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return
    if (('result' in message || 'error' in message) && 'id' in message && message.id !== undefined) this.answered(message.id)
    await new Promise<void>((resolve) => (this.output.write(serializeMessage(message)) ? resolve() : this.output.once('drain', resolve)))
  }

  private answered(id: string | number) {
    this.pending.delete(id)
    if (this.pending.size > 0) return
    const waiting = this.idle
    this.idle = []
    for (const resolve of waiting) resolve()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.buffer.clear()
    for (const resolve of this.idle) resolve()
    this.idle = []
    this.onclose?.()
  }
}
