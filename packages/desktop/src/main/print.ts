import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrintRequest, PrintResult } from '../shared/api'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'

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
  const name = Array.from(title, (c) => (c.charCodeAt(0) < 0x20 || c === '\u007f' || '/\\:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .slice(0, MAX_NAME)
    .trim()
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
}

const electronHost: PrintHost = {
  async choosePdfPath(sender, defaultName) {
    const win = BrowserWindow.fromWebContents(sender)
    const options = { title: 'Export Page as PDF', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'PDF', extensions: ['pdf'] }] }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return picked.canceled || !picked.filePath ? null : picked.filePath
  },
  // Straight to the chosen file: an encrypted vault's page never passes through a temp file.
  writePdf: (path, bytes) => writeFile(path, bytes),
  paper: () => paperFor(app.getLocaleCountryCode()),
}

/** File → Print… and File → Export Page as PDF…: the sender's own window, laid out by its print stylesheet. */
export function registerPrintIpc(ipc: IpcRegistrar, host: PrintHost = electronHost): void {
  ipc.handle(CH.pagePrint, async (e, request: unknown): Promise<PrintResult> => {
    if (!isPrintRequest(request)) throw new Error('Refused a malformed print request')
    const sender = e.sender
    if (request.kind === 'print') {
      return new Promise((resolve) => sender.print({ printBackground: true }, (done) => resolve({ done })))
    }
    const path = await host.choosePdfPath(sender, pdfFileName(request.title))
    if (!path) return { done: false }
    const bytes = await sender.printToPDF({ printBackground: true, pageSize: host.paper() })
    await host.writePdf(path, bytes)
    return { done: true }
  })
}
