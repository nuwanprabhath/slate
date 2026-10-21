import { randomUUID } from 'node:crypto'
import { hostname, platform } from 'node:os'
import { markdownToBlocks, PageDoc, writeContent } from '@slate/core'
import { GraphHttp } from '@slate/importer'
import { OneDriveClient, SyncEngine, type ConflictRecord, type SyncReport, type SyncStatus } from '@slate/sync'
import type { SyncState } from '../../shared/api'
import type { BlobStore } from '../blobs'
import { SIGN_IN_SCOPES, type AuthService } from '../onenote/auth'
import { readSettings, writeSettings } from '../settings'
import { DocStore } from '../store'
import { docStoreLocal } from './localStore'

const INTERVAL_MS = 30_000
const AFTER_EDIT_MS = 2_000

export interface SyncServiceDeps {
  dbFile: string
  blobs: BlobStore
  auth: AuthService
  graphUrl: string
  deviceName?: string
  /** Background sync period; 0 turns the timer off (tests drive `now()`). */
  intervalMs?: number
  emitStatus: (state: SyncState) => void
  emitNotice: (message: string) => void
}

/**
 * OneDrive sync for the app. Runs over its own database connection so that what it pulls reaches
 * the open window through the external-update watcher, like an agent's writes. While sync is off
 * or nobody is signed in, it makes no network call at all.
 */
export class SyncService {
  readonly deviceId: string
  private readonly store: DocStore
  private readonly engine: SyncEngine
  private readonly drive: OneDriveClient
  private report: SyncReport = { status: 'disabled', pushed: 0, pulled: 0, conflicts: 0, at: 0 }
  private lastSyncedAt: number | undefined
  private running: Promise<SyncReport> | undefined
  private again = false
  private timer: ReturnType<typeof setInterval> | undefined
  private soon: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly deps: SyncServiceDeps) {
    this.store = new DocStore(deps.dbFile, { compact: false })
    this.deviceId = readSettings(this.store).deviceId ?? writeSettings(this.store, { deviceId: randomUUID() }).deviceId!
    const http = new GraphHttp({ baseUrl: deps.graphUrl, getToken: () => deps.auth.token(SIGN_IN_SCOPES) })
    this.drive = new OneDriveClient(http)
    this.engine = new SyncEngine({
      local: docStoreLocal(this.store, deps.blobs, deps.emitNotice),
      remote: this.drive,
      deviceId: this.deviceId,
      deviceName: deps.deviceName ?? hostname(),
      platform: platform(),
    })
  }

  /** Syncs now and then every interval. */
  start(): void {
    const interval = this.deps.intervalMs ?? INTERVAL_MS
    if (interval > 0) this.timer = setInterval(() => void this.now(), interval)
    void this.now()
  }

  /** A local edit happened: sync shortly after, once edits pause. */
  edited(): void {
    if (this.soon) clearTimeout(this.soon)
    this.soon = setTimeout(() => {
      this.soon = undefined
      void this.now()
    }, AFTER_EDIT_MS)
  }

  private enabled(): boolean {
    return readSettings(this.store).syncEnabled
  }

  async status(): Promise<SyncState> {
    const auth = await this.deps.auth.status()
    return {
      ...this.report,
      enabled: this.enabled(),
      ...(auth.account ? { account: auth.account } : {}),
      ...(this.lastSyncedAt !== undefined ? { lastSyncedAt: this.lastSyncedAt } : {}),
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    writeSettings(this.store, { syncEnabled: on })
    if (on && !(await this.deps.auth.status()).signedIn) await this.deps.auth.signIn()
    if (on) await this.now()
    else await this.setReport(this.idle('disabled'))
  }

  /** One sync at a time; asking during a sync runs exactly one more after it. */
  now(): Promise<SyncReport> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = undefined
      if (this.again && !this.closed) {
        this.again = false
        void this.now()
      }
    })
    return this.running
  }

  private idle(status: SyncStatus): SyncReport {
    return { status, pushed: 0, pulled: 0, conflicts: 0, at: Date.now() }
  }

  private async run(): Promise<SyncReport> {
    if (this.closed) return this.report
    if (!this.enabled()) return this.setReport(this.idle('disabled'))
    if (!(await this.deps.auth.status()).signedIn) return this.setReport(this.idle('signed-out'))
    await this.setReport({ ...this.report, status: 'syncing' })
    const report = await this.engine.syncOnce()
    if (report.status === 'idle-synced') this.lastSyncedAt = report.at
    return this.setReport(report)
  }

  private async setReport(report: SyncReport): Promise<SyncReport> {
    this.report = report
    if (!this.closed) this.deps.emitStatus(await this.status())
    return report
  }

  conflicts(pageId?: string): ConflictRecord[] {
    return this.store.listConflicts(pageId)
  }

  /**
   * 'mine' and 'theirs' rewrite the box as a new local edit, which the next sync pushes;
   * 'merged' keeps what the merge produced.
   */
  async resolve(id: string, choice: 'merged' | 'mine' | 'theirs'): Promise<void> {
    const conflict = this.store.listConflicts().find((c) => c.id === id)
    if (!conflict) return
    if (choice !== 'merged') {
      const page = PageDoc.fromUpdates(this.store.load(conflict.pageId))
      const root = page.contentMap(conflict.boxId)
      if (root) {
        const from = page.doc.oplogVersion()
        writeContent(root, markdownToBlocks(choice === 'mine' ? conflict.mine : conflict.theirs), page.doc)
        page.doc.commit()
        this.store.append(conflict.pageId, page.doc.export({ mode: 'update', from }))
        this.edited()
      }
    }
    this.store.removeConflict(id)
  }

  /** For the slate-blob protocol: fetches an image another device pushed. False when it cannot. */
  async ensureBlob(name: string): Promise<boolean> {
    if (this.deps.blobs.has(name)) return true
    if (!this.enabled() || !(await this.deps.auth.status()).signedIn) return false
    try {
      this.deps.blobs.write(name, await this.drive.download(`blobs/${name}`))
      // Came from the drive, so there is nothing to push.
      this.store.markBlobSynced(name)
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.store.close()
  }
}
