import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphHttp, GraphOfflineError, MAX_RETRY_AFTER_MS, METADATA_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from '../src/graph'

/** A fetch that never answers, and records whether its signal was aborted. */
function stalledFetch() {
  const calls: Array<{ aborted: boolean; signal: AbortSignal | null }> = []
  const doFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null
    const call = { aborted: false, signal }
    calls.push(call)
    signal?.addEventListener('abort', () => (call.aborted = true), { once: true })
    return new Promise<Response>(() => {})
  }) as typeof fetch
  return { calls, doFetch }
}

const http = (over: Partial<ConstructorParameters<typeof GraphHttp>[0]> = {}) =>
  new GraphHttp({ baseUrl: 'https://graph.invalid/v1.0', getToken: async () => 'token', ...over })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('GraphHttp deadlines', () => {
  it('fails a metadata call as offline when the fetch never answers', async () => {
    const { calls, doFetch } = stalledFetch()
    const sent = http({ fetch: doFetch }).send('/me/drive', {})
    const seen = sent.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS - 1)
    await vi.advanceTimersByTimeAsync(1)
    const err = await seen
    expect(err).toBeInstanceOf(GraphOfflineError)
    expect((err as GraphOfflineError).offline).toBe(true)
    // Nothing is left waiting on the request: its signal aborted at the deadline.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.aborted).toBe(true)
  })

  it('gives a transfer ten minutes, not a metadata call’s minute', async () => {
    const { doFetch } = stalledFetch()
    const settled = vi.fn()
    void http({ fetch: doFetch }).send('/content', {}, { transfer: true }).catch(settled)
    await vi.advanceTimersByTimeAsync(METADATA_TIMEOUT_MS + 1_000)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TRANSFER_TIMEOUT_MS)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('stops a transfer the caller aborts, leaving no pending fetch', async () => {
    const { calls, doFetch } = stalledFetch()
    const abort = new AbortController()
    const seen = http({ fetch: doFetch })
      .send('/content', {}, { transfer: true, signal: abort.signal })
      .catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    abort.abort()
    const err = await seen
    expect(err).not.toBeInstanceOf(GraphOfflineError)
    expect((err as Error).name).toBe('AbortError')
    expect(calls[0]!.aborted).toBe(true)
  })

  it('waits at most two minutes however long Retry-After asks for', async () => {
    let attempts = 0
    const doFetch = (async () => {
      attempts++
      return attempts === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '86400' } })
        : new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const done = vi.fn()
    void http({ fetch: doFetch }).send('/me/drive', {}).then(done)
    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1)
    expect(attempts).toBe(1)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('gives up as offline once retries have cost ten minutes', async () => {
    const doFetch = (async () => new Response('slow down', { status: 503, headers: { 'Retry-After': '120' } })) as unknown as typeof fetch
    const seen = http({ fetch: doFetch, maxRetries: 1_000 })
      .send('/me/drive', {})
      .catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    const err = await seen
    expect(err).toBeInstanceOf(GraphOfflineError)
    expect((err as Error).message).toMatch(/wait/)
  })
})
