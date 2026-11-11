import { OfflineError, type DeltaPage, type RemoteDrive, type RemoteItem } from '../src/types'

export type MemoryDrive = RemoteDrive & {
  offline: boolean
  files: Map<string, Uint8Array>
  /** The signal each method was given, so a test can prove the running sync's signal reaches the drive. */
  signals: Array<AbortSignal | undefined>
}

export interface MemoryDriveOptions {
  /**
   * Gives the drive a `flush`, as the git drive has one (the memory drive publishes writes at once).
   * `stall` never answers, which is what a push to an unreachable remote does.
   */
  flush?: 'ok' | 'stall'
}

/** A RemoteDrive in memory. Cursors are positions in a change log, as in the HTTP fake. */
export function memoryDrive(opts: MemoryDriveOptions = {}): MemoryDrive {
  const files = new Map<string, Uint8Array>()
  const ids = new Map<string, string>()
  const log: RemoteItem[] = []
  const idOf = (path: string) => {
    let id = ids.get(path)
    if (!id) ids.set(path, (id = `item-${ids.size + 1}`))
    return id
  }

  const drive: MemoryDrive = {
    offline: false,
    files,
    signals: [],
    async upload(path, bytes, signal) {
      drive.signals.push(signal)
      if (drive.offline) throw new OfflineError()
      files.set(path, bytes.slice())
      log.push({ id: idOf(path), path, eTag: `e${log.length + 1}`, deleted: false, isFile: true })
    },
    async download(path, signal) {
      drive.signals.push(signal)
      if (drive.offline) throw new OfflineError()
      const bytes = files.get(path)
      if (!bytes) throw Object.assign(new Error(`404 ${path}`), { status: 404 })
      return bytes.slice()
    },
    async remove(path, signal) {
      drive.signals.push(signal)
      if (drive.offline) throw new OfflineError()
      if (!files.delete(path)) return
      log.push({ id: idOf(path), path, eTag: `e${log.length + 1}`, deleted: true, isFile: true })
    },
    async delta(cursor, signal): Promise<DeltaPage> {
      drive.signals.push(signal)
      if (drive.offline) throw new OfflineError()
      const latest = new Map<string, RemoteItem>()
      for (const item of log.slice(Number(cursor ?? 0))) {
        latest.delete(item.id)
        latest.set(item.id, item)
      }
      return { items: [...latest.values()], cursor: String(log.length) }
    }
  }
  if (opts.flush) {
    drive.flush = async (signal) => {
      drive.signals.push(signal)
      if (drive.offline) throw new OfflineError()
      if (opts.flush === 'stall') await new Promise<never>(() => {})
    }
  }
  return drive
}
