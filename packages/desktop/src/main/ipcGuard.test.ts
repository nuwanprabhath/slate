import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { APP_ENTRY } from './appProtocol'
import {
  CHANNEL_POLICY,
  createIpc,
  FLUSH_CHANNELS,
  guardHandlers,
  isTrustedSender,
  PRE_UNLOCK_CHANNELS,
  SELF_TEST_CHANNELS,
  SELF_TEST_POLICY,
  VAULT_CHANGE_CHANNELS,
  SelfTestFailed,
  UntrustedSender,
  type Channel,
  type RawIpc,
} from './ipcGuard'
import { Locked } from './vault/keyring'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake registrar takes any handler shape
type Handler = (...args: any[]) => unknown

const INVOKE: Channel[] = (Object.keys(CHANNEL_POLICY) as Array<keyof typeof CH>)
  .filter((k) => ['pre-unlock', 'flush', 'unlocked'].includes(CHANNEL_POLICY[k]))
  .map((k) => CH[k])

function registrar() {
  const handlers = new Map<string, Handler>()
  return { handlers, handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) }
}

describe('IPC guard (§6.3)', () => {
  it('refuses every channel outside the allowlist while locked, and allows the allowlist', async () => {
    const ipc = registrar()
    let open = false
    // A passing self-test before each vault change (review C6: the registrar runs one).
    const guarded = guardHandlers(ipc, () => open, () => false, async () => {})
    for (const channel of INVOKE) guarded.handle(channel, () => 'ok')
    expect(ipc.handlers.size).toBe(INVOKE.length)
    for (const channel of INVOKE) {
      const call = () => ipc.handlers.get(channel)!({})
      if (PRE_UNLOCK_CHANNELS.has(channel)) expect(await call(), channel).toBe('ok')
      else expect(call, channel).toThrow(Locked)
    }
    open = true
    for (const channel of INVOKE) expect(await ipc.handlers.get(channel)!({}), channel).toBe('ok')
  })

  it('keeps note channels off the allowlist', () => {
    for (const channel of [CH.docsLoad, CH.docsList, CH.settingsGet, CH.syncConflicts, CH.auditList, CH.searchQuery, CH.onenoteTree, CH.blobsCopyImage, CH.blobsCopyRich]) {
      expect(PRE_UNLOCK_CHANNELS.has(channel), channel).toBe(false)
    }
    for (const channel of [CH.vaultStatus, CH.vaultUnlock, CH.vaultUnlockRecovery, CH.openExternal, CH.appVersion, CH.updateState]) {
      expect(PRE_UNLOCK_CHANNELS.has(channel), channel).toBe(true)
    }
  })

  it('lets only note writes through while the lock flushes the renderer', async () => {
    const ipc = registrar()
    let flushing = true
    const guarded = guardHandlers(ipc, () => false, () => flushing)
    for (const channel of INVOKE) guarded.handle(channel, () => 'ok')
    for (const channel of FLUSH_CHANNELS) expect(await ipc.handlers.get(channel)!({}), channel).toBe('ok')
    expect([...FLUSH_CHANNELS].sort()).toEqual([CH.blobsPut, CH.docsAppend].sort())
    expect(() => ipc.handlers.get(CH.docsLoad)!({})).toThrow(Locked)
    flushing = false
    expect(() => ipc.handlers.get(CH.docsAppend)!({})).toThrow(Locked)
  })

  it('registers each channel only once', () => {
    const guarded = guardHandlers(registrar(), () => true)
    guarded.handle(CH.docsLoad, () => 1)
    expect(() => guarded.handle(CH.docsLoad, () => 2)).toThrow(/already registered/)
  })

  it('classifies every channel, and derives the allowlists from that table', () => {
    expect(Object.keys(CHANNEL_POLICY).sort()).toEqual(Object.keys(CH).sort())
    expect([...PRE_UNLOCK_CHANNELS].sort()).toEqual(
      [CH.vaultStatus, CH.vaultUnlock, CH.vaultUnlockRecovery, CH.vaultQuickUnlock, CH.chromeMenu, CH.updateState, CH.appVersion, CH.openExternal].sort(),
    )
  })

  it('refuses to register an event or a send channel as an invoke handler', () => {
    const guarded = guardHandlers(registrar(), () => true)
    expect(() => guarded.handle(CH.settingsChanged, () => 1)).toThrow(/not an invoke channel/)
    expect(() => guarded.handle(CH.vaultLock, () => 1)).toThrow(/not an invoke channel/)
  })
})

/** An IPC event from a frame at `url`; `parent` set makes it a sub-frame. */
const frameAt = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } })
const fromApp = frameAt(APP_ENTRY)

describe('isTrustedSender (B-2)', () => {
  const isApp = (url: string) => url.startsWith('app://slate/')
  it('T-B-02: false for a sub-frame, another page, a file page and no frame; true for the app entry', () => {
    expect(isTrustedSender({ url: APP_ENTRY, parent: { url: APP_ENTRY } }, isApp)).toBe(false)
    expect(isTrustedSender({ url: 'https://evil.invalid/', parent: null }, isApp)).toBe(false)
    expect(isTrustedSender({ url: 'file:///tmp/other.html', parent: null }, isApp)).toBe(false)
    expect(isTrustedSender(null, isApp)).toBe(false)
    expect(isTrustedSender(undefined, isApp)).toBe(false)
    expect(isTrustedSender({ url: APP_ENTRY, parent: null }, isApp)).toBe(true)
  })

  it("trusts a top frame whose page has not committed yet (the preload's sendSync) only in a window Slate's factory made", () => {
    expect(isTrustedSender({ url: '', parent: null }, isApp)).toBe(false)
    expect(isTrustedSender({ url: '', parent: null }, isApp, true)).toBe(true)
    expect(isTrustedSender({ url: '', parent: { url: APP_ENTRY } }, isApp, true)).toBe(false)
    expect(isTrustedSender({ url: 'https://evil.invalid/', parent: null }, isApp, true)).toBe(false)
  })

  it('is false for a destroyed frame whose properties throw', () => {
    const destroyed = {
      get url(): string {
        throw new Error('Render frame was disposed')
      },
      parent: null,
    }
    expect(isTrustedSender(destroyed, isApp)).toBe(false)
  })
})

describe('createIpc, the one registrar main code gets', () => {
  function rawIpc() {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, Set<Handler>>()
    const raw: RawIpc = {
      handle: (channel, handler) => void handlers.set(channel, handler),
      on: (channel, listener) => listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener)),
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    }
    return { raw, handlers, listeners }
  }

  it('gates every handler by the vault state', async () => {
    const { raw, handlers } = rawIpc()
    let open = false
    const ipc = createIpc(() => open, () => false, raw)
    ipc.handle(CH.docsLoad, () => 'page')
    ipc.handle(CH.vaultStatus, () => 'locked')
    expect(() => handlers.get(CH.docsLoad)!(fromApp)).toThrow(Locked)
    expect(await handlers.get(CH.vaultStatus)!(fromApp)).toBe('locked')
    open = true
    expect(await handlers.get(CH.docsLoad)!(fromApp)).toBe('page')
  })

  it('review L2: by default trusts only the app entry, not another app://slate/ document', () => {
    const { raw, handlers } = rawIpc()
    const ipc = createIpc(() => true, () => false, raw)
    ipc.handle(CH.vaultStatus, () => 'ok')
    expect(handlers.get(CH.vaultStatus)!(fromApp)).toBe('ok')
    for (const url of ['app://slate/assets/x.svg', 'app://slate/assets/']) expect(() => handlers.get(CH.vaultStatus)!(frameAt(url)), url).toThrow(UntrustedSender)
  })

  it('T-B-03: refuses an untrusted sender with UntrustedSender before reading the vault state or calling the handler', () => {
    const { raw, handlers } = rawIpc()
    let stateReads = 0
    let calls = 0
    const ipc = createIpc(() => (stateReads++, true), () => (stateReads++, true), raw)
    ipc.handle(CH.docsLoad, () => void calls++)
    ipc.handle(CH.vaultStatus, () => void calls++)
    for (const event of [{}, { senderFrame: null }, frameAt('https://evil.invalid/'), frameAt(APP_ENTRY, { url: APP_ENTRY })])
      for (const channel of [CH.docsLoad, CH.vaultStatus]) expect(() => handlers.get(channel)!(event), channel).toThrow(UntrustedSender)
    expect(stateReads).toBe(0)
    expect(calls).toBe(0)
  })

  it("answers the preload's sendSync from a Slate window before its page commits, and nobody else's", () => {
    const { raw, listeners } = rawIpc()
    const ours = { id: 1 }
    const ipc = createIpc(() => false, () => false, raw, undefined, (wc) => wc === ours)
    const got: unknown[] = []
    ipc.on(CH.themesInitial, (e) => void got.push(e.sender))
    listeners.get(CH.themesInitial)?.forEach((l) => l({ senderFrame: { url: '', parent: null }, sender: ours }))
    listeners.get(CH.themesInitial)?.forEach((l) => l({ senderFrame: { url: '', parent: null }, sender: { id: 2 } }))
    expect(got).toEqual([ours])
  })

  it("review M1: answers an untrusted sendSync with null instead of leaving that renderer blocked", () => {
    const { raw, listeners } = rawIpc()
    const ipc = createIpc(() => true, () => false, raw)
    let called = false
    ipc.on(CH.themesInitial, () => void (called = true))
    const event: { senderFrame: unknown; returnValue?: unknown } = frameAt('about:blank')
    listeners.get(CH.themesInitial)?.forEach((l) => l(event))
    expect(called).toBe(false)
    expect('returnValue' in event && event.returnValue).toBeNull()
  })

  it('drops a send message from an untrusted sender, even on a send-pre-unlock channel (B-2)', () => {
    const { raw, listeners } = rawIpc()
    const ipc = createIpc(() => true, () => false, raw)
    const got: string[] = []
    ipc.on(CH.vaultLock, () => void got.push('lock'))
    listeners.get(CH.vaultLock)?.forEach((l) => l(frameAt('https://evil.invalid/')))
    expect(got).toEqual([])
    listeners.get(CH.vaultLock)?.forEach((l) => l(fromApp))
    expect(got).toEqual(['lock'])
  })

  it('takes only send channels for `on`, and returns the unsubscribe', () => {
    const { raw, listeners } = rawIpc()
    const ipc = createIpc(() => true, () => false, raw)
    const off = ipc.on(CH.vaultFlushed, () => {})
    expect(listeners.get(CH.vaultFlushed)?.size).toBe(1)
    off()
    expect(listeners.get(CH.vaultFlushed)?.size).toBe(0)
    expect(() => ipc.on(CH.docsLoad, () => {})).toThrow(/not a send channel/)
  })

  it('drops a send message while locked unless its channel is send-pre-unlock (red team 2b)', () => {
    const { raw, listeners } = rawIpc()
    let open = false
    const ipc = createIpc(() => open, () => false, raw)
    const got: string[] = []
    ipc.on(CH.vaultCopied, () => void got.push('copied'))
    ipc.on(CH.vaultLock, () => void got.push('lock'))
    const fire = (channel: string) => listeners.get(channel)?.forEach((l) => l(fromApp))
    fire(CH.vaultCopied)
    fire(CH.vaultLock)
    expect(got).toEqual(['lock'])
    open = true
    fire(CH.vaultCopied)
    expect(got).toEqual(['lock', 'copied'])
  })

  it('builds one registrar per ipcMain: a second, always-open one cannot be made (red team 2c)', () => {
    const { raw } = rawIpc()
    createIpc(() => false, () => false, raw)
    expect(() => createIpc(() => true, () => true, raw)).toThrow(/once/)
  })
})

describe('T-POST-09: IPC while the power-up self-test runs or after it failed (audit §4.2 table, S-6)', () => {
  // The channels the audit's table allows in `selftest` and `selftest-failed`: status, version, window chrome,
  // quit and the diagnostic report (the error screen's two buttons). Everything else refuses.
  const ALLOWED_INVOKE = [CH.vaultStatus, CH.appVersion, CH.chromeMenu, CH.appQuit, CH.diagnosticsCopyReport]

  it('decides every channel, by type, as CHANNEL_POLICY does', () => {
    expect(Object.keys(SELF_TEST_POLICY).sort()).toEqual(Object.keys(CH).sort())
  })

  it('serves exactly the self-test set of invoke channels; every other registered channel throws SelfTestFailed', async () => {
    const ipc = registrar()
    let gate: boolean | 'self-test' = 'self-test'
    const guarded = guardHandlers(ipc, () => gate, () => true)
    for (const channel of INVOKE) guarded.handle(channel, () => 'ok')
    // Every registered channel is enumerated and compared with the policy.
    expect(ipc.handlers.size).toBe(INVOKE.length)
    const served: string[] = []
    for (const channel of INVOKE) {
      const call = () => ipc.handlers.get(channel)!({})
      if (SELF_TEST_CHANNELS.has(channel)) {
        expect(await call(), channel).toBe('ok')
        served.push(channel)
      } else expect(call, channel).toThrow(SelfTestFailed)
    }
    expect(served.sort()).toEqual([...ALLOWED_INVOKE].sort())
    // Flushing does not open the note writes either: the lock's flush never runs from a self-test state.
    expect(() => ipc.handlers.get(CH.docsAppend)!({})).toThrow(SelfTestFailed)
    gate = true
    expect(await ipc.handlers.get(CH.docsLoad)!({})).toBe('ok')
  })

  it("refuses with a message the renderer shows as 'self-test failed', never as Locked", () => {
    expect(new SelfTestFailed().message).toContain('self-test failed')
    expect(new SelfTestFailed()).not.toBeInstanceOf(Locked)
  })

  it('the new channels are no pre-unlock channels: a locked vault does not serve quit or the report', () => {
    for (const channel of [CH.appQuit, CH.diagnosticsCopyReport, CH.vaultSelfTest]) expect(PRE_UNLOCK_CHANNELS.has(channel), channel).toBe(false)
    // Settings → Security → Run self-tests: notes are open, so it is an ordinary unlocked channel.
    expect(SELF_TEST_CHANNELS.has(CH.vaultSelfTest)).toBe(false)
  })

  it('through createIpc: refuses SelfTestFailed after the sender check, and drops sends except window chrome', async () => {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, Set<Handler>>()
    const raw: RawIpc = {
      handle: (channel, handler) => void handlers.set(channel, handler),
      on: (channel, listener) => listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener)),
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    }
    const ipc = createIpc(() => 'self-test', () => true, raw)
    ipc.handle(CH.docsList, () => 'notes')
    ipc.handle(CH.vaultUnlock, () => 'unlocked')
    ipc.handle(CH.vaultStatus, () => 'status')
    expect(() => handlers.get(CH.docsList)!(fromApp)).toThrow(SelfTestFailed)
    await expect(handlers.get(CH.vaultUnlock)!(fromApp, new Uint8Array(4))).rejects.toThrow(SelfTestFailed)
    expect(await handlers.get(CH.vaultStatus)!(fromApp)).toBe('status')
    expect(() => handlers.get(CH.docsList)!(frameAt('https://evil.invalid/'))).toThrow(UntrustedSender)
    const got: string[] = []
    for (const channel of [CH.vaultLock, CH.vaultFlushed, CH.vaultActivity, CH.vaultCopied, CH.themesInitial, CH.chromeKind]) ipc.on(channel, () => void got.push(channel))
    for (const channel of [CH.vaultLock, CH.vaultFlushed, CH.vaultActivity, CH.vaultCopied, CH.themesInitial, CH.chromeKind]) listeners.get(channel)?.forEach((l) => l(fromApp))
    // The error window's preload still reads its theme and title bar; nothing reaches the vault.
    expect(got).toEqual([CH.themesInitial, CH.chromeKind])
  })
})

describe('review C6: every vault-changing channel runs the self-test first, in the registrar (S-7 b)', () => {
  const rawIpc = () => {
    const handlers = new Map<string, Handler>()
    const raw: RawIpc = { handle: (c, h) => void handlers.set(c, h), on: () => {}, removeListener: () => {} }
    return { raw, handlers }
  }

  it('names exactly the channels that write a vault key or file', () => {
    expect(Object.keys(VAULT_CHANGE_CHANNELS).sort()).toEqual(
      ['vaultChangePassword', 'vaultEncrypt', 'vaultEncryptRemote', 'vaultFinishMigration', 'vaultJoin', 'vaultNewRecovery', 'vaultPrepare', 'vaultQuickUnlockEnable', 'vaultRekeyPrepare', 'vaultRekeyRun'].sort(),
    )
  })

  it('runs the self-test before the handler, after the vault gate; a failed self-test stops the change', async () => {
    const { raw, handlers } = rawIpc()
    const seen: string[] = []
    let pass = true
    let open = true
    const ipc = createIpc(() => open, () => false, raw, undefined, undefined, async () => {
      seen.push('post')
      if (!pass) throw new SelfTestFailed()
    })
    ipc.handle(CH.vaultQuickUnlockEnable, () => void seen.push('enable'))
    ipc.handle(CH.vaultEncrypt, () => void seen.push('encrypt'))
    ipc.handle(CH.docsList, () => void seen.push('list'))
    await handlers.get(CH.vaultQuickUnlockEnable)!(fromApp, new Uint8Array(4))
    await handlers.get(CH.vaultEncrypt)!(fromApp)
    await handlers.get(CH.docsList)!(fromApp)
    expect(seen).toEqual(['post', 'enable', 'post', 'encrypt', 'list'])
    pass = false
    await expect(handlers.get(CH.vaultEncrypt)!(fromApp)).rejects.toThrow(SelfTestFailed)
    expect(seen.at(-1)).toBe('post')
    // Locked: refused by the gate, no self-test run for a call that cannot happen.
    open = false
    seen.length = 0
    expect(() => handlers.get(CH.vaultEncrypt)!(fromApp)).toThrow(Locked)
    expect(seen).toEqual([])
  })
})
