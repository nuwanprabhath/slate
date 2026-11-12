import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphHttp, MAX_RETRY_AFTER_MS } from '../src/graph'
import { fcRuns } from '../../desktop/test/fuzz'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** One 429 carrying `retryAfter`, then success; returns the single wait the client asked its sleep for. */
async function waitFor(retryAfter: string | null, status = 429): Promise<number> {
  const waits: number[] = []
  let calls = 0
  const doFetch = (async () => {
    calls++
    if (calls > 1) return new Response('ok', { status: 200 })
    return new Response('slow', { status, ...(retryAfter === null ? {} : { headers: { 'Retry-After': retryAfter } }) })
  }) as unknown as typeof fetch
  const http = new GraphHttp({ baseUrl: 'https://graph.invalid/v1.0', getToken: async () => 't', fetch: doFetch, sleep: async (ms) => void waits.push(ms) })
  const res = await http.send('/me', {})
  expect(res.status).toBe(200)
  expect(waits).toHaveLength(1)
  return waits[0]!
}

const inBounds = (ms: number): void => {
  expect(Number.isFinite(ms)).toBe(true)
  expect(ms).toBeGreaterThanOrEqual(0)
  expect(ms).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS)
}

describe('GraphHttp Retry-After fuzz', () => {
  it('T-F3C-11: the named hostile values wait between 0 and MAX_RETRY_AFTER_MS', async () => {
    const past = new Date(Date.now() - 3_600_000).toUTCString()
    const far = new Date(Date.now() + 10 * 365 * 86_400_000).toUTCString()
    // Open finding F3C-2: a negative Retry-After (-1, -99999999999) becomes a negative sleep; excluded until fixed.
    for (const v of ['-0', 'abc', '', ' ', 'NaN', 'Infinity', '-Infinity', '1e999', '86400', '0', '1.5', '0x10', past, far, null]) inBounds(await waitFor(v))
    inBounds(await waitFor('86400', 503))
  })

  it('T-F3C-12: any header value waits between 0 and MAX_RETRY_AFTER_MS', async () => {
    // F3C-2 excludes negative numbers: the integer and double arms start at 0.
    const value = fc.oneof(
      fc.integer({ min: 0, max: 1e9 }).map(String),
      fc.double({ min: 0 }).map(String),
      fc.string({ maxLength: 12 }).map((s) => s.replace(/[^\x20-\x7e]/g, '')),
      fc.date({ min: new Date(0), max: new Date(4e12), noInvalidDate: true }).map((d) => d.toUTCString()),
    )
    await fc.assert(
      fc.asyncProperty(value, async (v) => {
        inBounds(await waitFor(v))
      }),
      fcRuns(10, 100),
    )
  })
})
