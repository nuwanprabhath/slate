import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrintRequest, PrintResult } from '../shared/api'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'
import { insideDataDir } from './vault/recoveryFile'

const MAX_TITLE = 1000
const MAX_NAME = 120
// Where Letter paper is the norm; everywhere else gets A4.
const LETTER_COUNTRIES = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR'])

export type Paper = 'A4' | 'Letter'

/** The renderer is untrusted: exactly a print, or a PDF export carrying only the page title. */
export function isPrintRequest(value: unknown): value is PrintRequest {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  const keys = Object.keys(r).length
  if (r.kind === 'print') return keys === 1
  return r.kind === 'pdf' && keys === 2 && typeof r.title === 'string' && r.title.length <= MAX_TITLE
}

/** The save dialog's suggested name: the title as one plain file name, never a path. */
export function pdfFileName(title: string): string {
  // Code points, so a cut never splits an emoji; \p{Cf} takes the bidi overrides that can disguise a name.
  const cleaned = Array.from(title, (c) => (/[\p{Cc}\p{Cf}]/u.test(c) || '/\\:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
  const name = Array.from(cleaned).slice(0, MAX_NAME).join('').trim()
  return `${name || 'Untitled page'}.pdf`
}

export function paperFor(country: string): Paper {
  return LETTER_COUNTRIES.has(country.toUpperCase()) ? 'Letter' : 'A4'
}

export interface PrintHost {
  /** The file the person picked in the save dialog, or null when they cancelled. */
  choosePdfPath(sender: WebContents, defaultName: string): Promise<string | null>
  writePdf(path: string, bytes: Uint8Array): Promise<void>
  paper(): Paper
  /** Notes are open (unlocked or plaintext): rechecked after each await, since a lock can start meanwhile. */
  isOpen(): boolean
  /** Why `path` may not take the PDF, or null when it may. */
  refusePath(path: string): string | null
  /** A fixed message, never the error's own text: that quotes the path, i.e. the page title. */
  showError(sender: WebContents, message: string): void
}

export function electronPrintHost(dataDir: string, isOpen: () => boolean): PrintHost {
  return {
    async choosePdfPath(sender, defaultName) {
      const win = BrowserWindow.fromWebContents(sender)
      const options = { title: 'Export Page as PDF', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'PDF', extensions: ['pdf'] }] }
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      return picked.canceled || !picked.filePath ? null : picked.filePath
    },
    // Straight to the chosen file, owner-only: an encrypted vault's page never passes through a temp file.
    // The mode at open only applies to a new file, so a replaced one is narrowed before the page lands in it.
    async writePdf(path, bytes) {
      const file = await open(path, 'w', 0o600)
      try {
        await file.chmod(0o600)
        await file.writeFile(bytes)
      } finally {
        await file.close()
      }
    },
    paper: () => paperFor(app.getLocaleCountryCode()),
    isOpen,
    // A sync clone in the data folder would commit the decrypted page.
    refusePath: (path) => (insideDataDir(path, dataDir) ? 'Choose a folder outside Slate’s data folder.' : null),
    showError(sender, message) {
      const win = sender.isDestroyed() ? null : BrowserWindow.fromWebContents(sender)
      const box = { type: 'warning' as const, message }
      void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).catch(() => {})
    },
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'
}

/** File → Print… and File → Export Page as PDF…: the sender's own window, laid out by its print stylesheet. */
export function registerPrintIpc(ipc: IpcRegistrar, host: PrintHost): void {
  // One dialog per window: a second request while one is open would queue another sheet.
  const inFlight = new Set<number>()
  const exportPdf = async (sender: WebContents, title: string): Promise<PrintResult> => {
    const path = await host.choosePdfPath(sender, pdfFileName(title))
    if (!path || sender.isDestroyed() || !host.isOpen()) return { done: false }
    const refused = host.refusePath(path)
    if (refused) {
      host.showError(sender, refused)
      return { done: false }
    }
    try {
      const bytes = await sender.printToPDF({ printBackground: true, pageSize: host.paper() })
      if (sender.isDestroyed() || !host.isOpen()) return { done: false }
      await host.writePdf(path, bytes)
      return { done: true }
    } catch (error) {
      const code = errorCode(error)
      host.showError(sender, `Could not save the PDF (${code}).`)
      return { done: false, error: code }
    }
  }
  ipc.handle(CH.pagePrint, async (e, request: unknown): Promise<PrintResult> => {
    if (!isPrintRequest(request)) throw new Error('Refused a malformed print request')
    const sender = e.sender
    if (inFlight.has(sender.id)) return { done: false }
    inFlight.add(sender.id)
    try {
      if (request.kind === 'print') return await new Promise<PrintResult>((resolve) => sender.print({ printBackground: true }, (done) => resolve({ done })))
      return await exportPdf(sender, request.title)
    } finally {
      inFlight.delete(sender.id)
    }
  })
}
