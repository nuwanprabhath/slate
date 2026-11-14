import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { MalformedRequest, MAX_LIST, MAX_STRING, MAX_UPDATE_BYTES } from '../shared/ipcValidators'
import { fcParams, fuzzTimeout } from '../../test/fuzz'
import { allHandlers, type ServiceCall } from '../../test/ipcHarness'

// F4a: every invoke handler, fed any argument list, refuses with its own MalformedRequest before any
// service is reached, or lets through only values within the caps. Channels come from the registrar's
// handler map, so a channel added without a validator is covered without editing this file.

const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const docId = `page:${uuid}`
const git = { remoteUrl: 'https://example.invalid/notes.git', branch: 'main', auth: 'system' }

/** A well-formed argument list per channel (ipc.test.ts's cases); the generator replaces one position. */
const VALID: Record<string, unknown[]> = {
  [CH.docsList]: ['notebook:'],
  [CH.docsLoad]: [docId],
  [CH.docsAppend]: [docId, new Uint8Array([1, 2, 3])],
  [CH.docsRemove]: [docId],
  [CH.blobsPut]: [new Uint8Array(1), 'image/png'],
  [CH.settingsSet]: [{ debugLog: true }],
  [CH.auditList]: [10],
  [CH.syncSetEnabled]: [true],
  [CH.syncConfigure]: [{ provider: 'git', git }],
  [CH.syncTestGit]: [git, 'token'],
  [CH.syncCreateRepo]: ['notes', 'system'],
  [CH.syncConflicts]: [docId],
  [CH.syncResolve]: [uuid, 'mine'],
  [CH.syncOpened]: [uuid],
  [CH.onenoteStart]: [[uuid]],
  [CH.onenoteSetClientId]: ['client'],
  [CH.blobsCopyRich]: ['<p>x</p>', 'x'],
  [CH.blobsCopyImage]: ['slate-blob://abc.png'],
  [CH.themesRename]: [`user:${uuid}`, 'Midnight'],
  [CH.themesRemove]: [`user:${uuid}`],
}

/**
 * Handlers that reach Electron or the OS directly instead of a service, so the fake services cannot
 * trace them: the file dialog, the system clipboard, `openExternalSafe` (openExternal.test.ts), and the
 * theme generator and its probe, which look for and start the `claude` program (refusals: ipc.test.ts).
 */
const UNTRACEABLE = new Set<string>([CH.onenotePickBackup, CH.clipboardText, CH.openExternal, CH.themesGenerate, CH.themesCancel, CH.themesClaude])

/** One instance each, so a run does not allocate 16 MiB. */
const OVERSIZE: unknown[] = [new Uint8Array(MAX_UPDATE_BYTES + 1), 'x'.repeat(MAX_STRING + 1), new Array<string>(MAX_LIST + 1).fill('a'), `page:${'a'.repeat(MAX_STRING)}`]

const value: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: fc.anything({ withTypedArray: true, withMap: true, withSet: true, withNullPrototype: true }) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 8 }) },
  { weight: 1, arbitrary: fc.constantFrom(...OVERSIZE) },
  { weight: 1, arbitrary: fc.constantFrom('', 'page:', 'notebook:', docId, uuid, `user:${uuid}`, 'image/png', 'mine', 'system', '__proto__') },
  { weight: 1, arbitrary: fc.constant(JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}') as unknown) },
)

// One registration for the file: `registerIpc` adds settings listeners each time it runs.
const { handlers, calls } = allHandlers()
const CHANNELS = [...handlers.keys()].filter((c) => !UNTRACEABLE.has(c)).sort()

const argsFor = (channel: string): fc.Arbitrary<unknown[]> => {
  const valid = VALID[channel]
  const free = fc.array(value, { maxLength: 4 })
  if (!valid) return free
  const replaced = fc.tuple(fc.nat({ max: valid.length - 1 }), value).map(([i, v]) => valid.map((a, j) => (j === i ? v : a)))
  return fc.oneof(free, replaced, fc.constant(valid))
}

const request = fc.constantFrom(...CHANNELS).chain((channel) => argsFor(channel).map((args) => ({ channel, args })))

/** Calls one handler; the services record what got through. */
async function invoke(channel: string, args: unknown[]): Promise<{ error: unknown; calls: ServiceCall[] }> {
  calls.length = 0
  let error: unknown = null
  let timer: ReturnType<typeof setTimeout> | undefined
  // A handler call costs microseconds; the deadline is far above that and only names a handler that never settles.
  const hung = new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error(`${channel} never settled`)), 1000)))
  try {
    await Promise.race([Promise.resolve().then(() => handlers.get(channel)!({} as never, ...args)), hung])
  } catch (e) {
    error = e
  } finally {
    clearTimeout(timer)
  }
  expect(String(error)).not.toMatch(/never settled/)
  return { error, calls: [...calls] }
}

// Independent of `isDocId`, so a change there is checked against the spec, not itself.
const DOC_ID = /^(page|notebook):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The service methods whose first argument is a document id. */
const TAKES_DOC_ID = new Set(['store.load', 'store.append', 'store.remove'])
/** Bytes whose cap is the storer's own (`BlobStore.put`'s ImageTooLarge). */
const OWN_BYTE_CAP = new Set(['blobs.put'])
/** A copied page's text and HTML: `blobsCopyRich` caps them at MAX_COPY_LENGTH (16 MiB), not MAX_STRING. */
const OWN_STRING_CAP = new Set(['clipboard.writeRich'])

/** Why a recorded call is out of bounds, or null. */
function outOfBounds(call: ServiceCall): string | null {
  const name = `${call.service}.${call.method}`
  if (TAKES_DOC_ID.has(name) && !(typeof call.args[0] === 'string' && DOC_ID.test(call.args[0]))) return `${name}: document id ${String(call.args[0]).slice(0, 40)}`
  const seen = new Set<unknown>()
  const walk = (v: unknown, path: string): string | null => {
    if (typeof v === 'string') return v.length > MAX_STRING && !OWN_STRING_CAP.has(name) ? `${path}: string of ${v.length}` : null
    if (v instanceof Uint8Array) return v.byteLength > MAX_UPDATE_BYTES && !OWN_BYTE_CAP.has(name) ? `${path}: ${v.byteLength} bytes` : null
    if (typeof v !== 'object' || v === null || seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v) && v.length > MAX_LIST) return `${path}: list of ${v.length}`
    for (const [k, x] of Object.entries(v)) {
      const bad = walk(x, `${path}.${k}`)
      if (bad) return bad
    }
    return null
  }
  return walk(call.args, name)
}

describe('FX-7: themes:save bounds its spec', () => {
  it('refuses a Uint8Array spec and an over-cap plain object before any service', async () => {
    for (const spec of [new Uint8Array(16 * 1024 * 1024), new Uint8Array(4), { name: 'x'.repeat(100_000) }]) {
      const { error, calls } = await invoke(CH.themesSave, [spec])
      expect(error).toBeInstanceOf(MalformedRequest)
      expect(calls).toEqual([])
    }
  })
})

describe('F4a: IPC handlers refuse what their validators do not accept', () => {
  it('T-F4A-01: covers every registered invoke channel', () => {
    // A sanity bound: the registrar holds every channel ipc.test.ts lists, plus the payload-free ones.
    expect(CHANNELS.length).toBeGreaterThanOrEqual(Object.keys(VALID).length)
    for (const c of Object.keys(VALID)) expect(CHANNELS, c).toContain(c)
  })

  it(
    'T-F4A-02: a handler refuses with its own MalformedRequest and reaches no service, or proceeds; it never throws anything else first',
    async () => {
      await fc.assert(
        fc.asyncProperty(request, async ({ channel, args }) => {
          const { error, calls } = await invoke(channel, args)
          if (error instanceof MalformedRequest) {
            expect(error.message).toBe(`Refused a malformed ${channel} request`)
            expect(calls).toEqual([])
          } else if (error !== null) {
            // The fake services return undefined, so code after the call may trip over it; a failure
            // before any service was reached is a handler that did not validate its arguments.
            expect(calls.length, `${channel} threw ${String(error)} before reaching a service`).toBeGreaterThan(0)
          }
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )

  it(
    'T-F4A-03: nothing oversize or mistyped reaches a service',
    async () => {
      await fc.assert(
        fc.asyncProperty(request, async ({ channel, args }) => {
          const { calls } = await invoke(channel, args)
          for (const call of calls) expect(outOfBounds(call), channel).toBeNull()
        }),
        fcParams,
      )
    },
    fuzzTimeout(),
  )

  it(
    'T-F4A-04: Object.prototype gains no property from any call',
    async () => {
      const before = Reflect.ownKeys(Object.prototype)
      await fc.assert(
        fc.asyncProperty(request, async ({ channel, args }) => {
          await invoke(channel, args)
          expect(Reflect.ownKeys(Object.prototype), channel).toEqual(before)
        }),
        { ...fcParams, numRuns: Math.max(200, Math.floor(fcParams.numRuns / 4)) },
      )
    },
    fuzzTimeout(),
  )
})
