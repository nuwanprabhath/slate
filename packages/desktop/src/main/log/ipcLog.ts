import { errorMessage } from './errorMessage'
import type { Logger } from './logger'

type Handler = (...args: never[]) => unknown

interface Registrar {
  handle(channel: string, handler: (...args: never[]) => unknown): void
}

/**
 * Wraps `ipcMain.handle` so a handler that throws or rejects leaves a line in the log, then fails
 * the same way it did before. Only the channel and the error are logged, never the arguments:
 * they carry note content.
 */
export function logHandlers<T extends Registrar>(ipc: T, logger: Logger): T {
  const failed = (channel: string, error: unknown) =>
    logger.error('ipc', 'ipc handler failed', { channel, error: errorMessage(error) })
  return {
    ...ipc,
    handle: (channel: string, handler: Handler) =>
      ipc.handle(channel, (...args) => {
        try {
          const result = handler(...args)
          if (result instanceof Promise) return result.catch((e: unknown) => { failed(channel, e); throw e })
          return result
        } catch (e) {
          failed(channel, e)
          throw e
        }
      }),
  }
}
