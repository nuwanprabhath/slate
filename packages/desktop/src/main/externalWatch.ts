import type { ExternalBatch } from '../shared/api'
import { noLog, type ScopedLog } from './log/logger'
import type { DocStore } from './store'

const POLL_MS = 500

/**
 * Feeds the renderer the updates another process (the slate-mcp CLI) wrote to the database.
 * `PRAGMA data_version` changes only for other connections' commits, so this costs one cheap query
 * per tick while nothing happens. Rows the app itself wrote can be included; Loro imports are
 * idempotent, so re-importing them is harmless.
 */
export function createExternalWatch(
  store: DocStore,
  emit: (batches: ExternalBatch[]) => void,
  log: ScopedLog = noLog,
): { check(): void; stop(): void } {
  let version = store.dataVersion()
  let lastId = store.maxUpdateId()
  const check = () => {
    const now = store.dataVersion()
    if (now === version) return
    version = now
    const rows = store.updatesSince(lastId)
    if (rows.length === 0) return
    lastId = rows[rows.length - 1].id
    const byDoc = new Map<string, Uint8Array[]>()
    for (const row of rows) byDoc.set(row.docId, [...(byDoc.get(row.docId) ?? []), row.data])
    log.info('external updates', { docs: byDoc.size, updates: rows.length })
    emit([...byDoc].map(([docId, updates]) => ({ docId, updates })))
  }
  const timer = setInterval(check, POLL_MS)
  return { check, stop: () => clearInterval(timer) }
}
