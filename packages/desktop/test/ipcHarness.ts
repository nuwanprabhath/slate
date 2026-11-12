// The registrar and service fakes the IPC handler tests share (ipc.test.ts, ipcFuzz.test.ts): every
// invoke handler registered against a fake registrar, with services that record each call.
import { registerIpc, registerOneNoteIpc, registerSyncIpc } from '../src/main/ipc'
import { registerCopyIpc, type CopyClipboard } from '../src/main/copyHtml'
import { registerThemeIpc } from '../src/main/theme/ipc'
import type { ThemeStore } from '../src/main/theme/themeStore'
import type { BlobStore } from '../src/main/blobs'
import type { AuthService } from '../src/main/onenote/auth'
import type { ImportService } from '../src/main/onenote/importService'
import type { Handler, IpcRegistrar } from '../src/main/ipcGuard'
import type { DocStore } from '../src/main/store'
import type { SyncService } from '../src/main/sync/syncService'

// The golden-path example for a handler (docs/architecture/golden-paths.md#ipc): it checks every
// argument from the untrusted renderer before main acts on it, and is tested with a fake registrar.
export function fakeRegistrar() {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  return { ipc, handlers }
}

/** One method call on a traced service, with the arguments it was given. */
export interface ServiceCall {
  service: string
  method: string
  args: unknown[]
}

/** Any method call on a service means the arguments got past the validator. */
export function tracingServices() {
  const reached: string[] = []
  const calls: ServiceCall[] = []
  const service = <T>(name: string): T =>
    new Proxy(
      {},
      {
        get:
          (_target, key) =>
          (...args: unknown[]) => {
            reached.push(`${name}.${String(key)}(${args.length})`)
            calls.push({ service: name, method: String(key), args })
            return undefined
          },
      },
    ) as T
  return { reached, calls, service }
}

export function allHandlers() {
  const { ipc, handlers } = fakeRegistrar()
  const { reached, calls, service } = tracingServices()
  registerIpc(
    ipc,
    () => service<DocStore>('store'),
    () => service<BlobStore>('blobs'),
    () => reached.push('onAppend'),
    () => reached.push('onRemove'),
  )
  registerSyncIpc(ipc, () => service<SyncService>('sync'))
  registerOneNoteIpc(ipc, service<AuthService>('auth'), () => service<ImportService>('importer'), () => reached.push('setClientId'))
  registerCopyIpc(ipc, () => service<BlobStore>('blobs'), service<CopyClipboard>('clipboard'), () => reached.push('onCopied'))
  registerThemeIpc(ipc, { open: () => ({ db: service<DocStore>('db'), themes: service<ThemeStore>('themes') }), preunlock: () => null }, false)
  return { handlers, reached, calls }
}
