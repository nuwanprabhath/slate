import type { Readable, Writable } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Newline-delimited JSON-RPC over any byte stream pair, framed exactly as the stdio transport
 * frames it, so `slate-mcp` can relay bytes between the two without parsing them. It counts
 * requests still waiting for their response, so the app can let them finish before it locks.
 */
export class LineTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private readonly pending = new Set<string | number>()
  private idle: Array<() => void> = []
  private closed = false
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

  private readonly onData = (chunk: Buffer) => {
    this.buffer.append(chunk)
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
