import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTlsPolicy, HYBRID_TLS_GROUP } from './tlsPolicy'

// A test-only self-signed P-256 certificate (fixtures/tls/README.md).
const cert = readFileSync(join(__dirname, 'fixtures/tls/cert.pem'))
const key = readFileSync(join(__dirname, 'fixtures/tls/key.pem'))

/** Handshakes a client with default options (plus the fixture CA) against a loopback server offering only `group`. */
async function negotiatedGroup(group: string): Promise<string | undefined> {
  const server = tls.createServer({ cert, key, ecdhCurve: group }, (socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    return await new Promise<string | undefined>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert }, () => {
        const info = socket.getEphemeralKeyInfo()
        const name = info !== null && 'name' in info ? info.name : undefined
        socket.end()
        resolve(name)
      })
      socket.on('error', reject)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('TLS key-exchange policy (PQ-C3)', () => {
  const original = tls.DEFAULT_ECDH_CURVE
  afterEach(() => {
    tls.DEFAULT_ECDH_CURVE = original
  })

  it('T-PQ-C3-01: the default client offers X25519MLKEM768 and a hybrid-only server negotiates it', async () => {
    applyTlsPolicy({ warn: () => {} })
    expect(HYBRID_TLS_GROUP).toBe('X25519MLKEM768')
    expect(await negotiatedGroup(HYBRID_TLS_GROUP)).toBe('X25519MLKEM768')
  })

  it('T-PQ-C3-02: a server restricted to secp384r1 still connects with the default client (classical fallback kept)', async () => {
    applyTlsPolicy({ warn: () => {} })
    expect(await negotiatedGroup('secp384r1')).toBe('secp384r1')
  })

  it("T-PQ-C3-04: applyTlsPolicy() after something set DEFAULT_ECDH_CURVE = 'X25519' restores 'auto' and logs the event once", () => {
    const events: { message: string; fields: unknown }[] = []
    const sink = { warn: (message: string, fields?: unknown) => events.push({ message, fields }) }
    tls.DEFAULT_ECDH_CURVE = 'X25519'
    applyTlsPolicy(sink)
    expect(tls.DEFAULT_ECDH_CURVE).toBe('auto')
    applyTlsPolicy(sink)
    expect(events).toEqual([{ message: 'transport.tls.policy-changed', fields: { from: 'X25519', to: 'auto' } }])
  })

  it("T-PQ-C3-04: applyTlsPolicy() leaves the default 'auto' alone and logs nothing", () => {
    const events: string[] = []
    applyTlsPolicy({ warn: (message: string) => events.push(message) })
    expect(tls.DEFAULT_ECDH_CURVE).toBe('auto')
    expect(events).toEqual([])
  })
})
