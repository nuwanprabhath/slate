import { describe, expect, it, vi } from 'vitest'
import { CH } from '../shared/ipc'
import type { Handler, IpcRegistrar } from './ipcGuard'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }))
const { isPrintRequest, paperFor, pdfFileName, registerPrintIpc } = await import('./print')
type Host = Parameters<typeof registerPrintIpc>[1]

function setup(host: Partial<Host> = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  const written: Array<{ path: string; bytes: Uint8Array }> = []
  const chosen: string[] = []
  const full: Host = {
    choosePdfPath: (_sender, name) => (chosen.push(name), Promise.resolve(`/Users/me/Documents/${name}`)),
    writePdf: (path, bytes) => (written.push({ path, bytes }), Promise.resolve()),
    paper: () => 'A4',
    ...host,
  }
  registerPrintIpc(ipc, full)
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46])
  const sender = {
    print: vi.fn((_opts: unknown, done: (ok: boolean, reason: string) => void) => done(true, '')),
    printToPDF: vi.fn(() => Promise.resolve(pdf)),
  }
  const call = (...args: unknown[]) => handlers.get(CH.pagePrint)!({ sender } as never, ...args)
  return { handlers, written, chosen, sender, call, pdf }
}

describe('isPrintRequest', () => {
  it('takes a print, or a PDF export with its page title, and nothing else from the renderer', () => {
    expect(isPrintRequest({ kind: 'print' })).toBe(true)
    expect(isPrintRequest({ kind: 'pdf', title: 'Meeting notes' })).toBe(true)
    for (const bad of [null, 'print', {}, { kind: 'pdf' }, { kind: 'pdf', title: 3 }, { kind: 'pdf', title: 'x'.repeat(1001) }, { kind: 'save' }, { kind: 'print', silent: true }, { kind: 'pdf', title: 'x', path: '/etc/x' }]) {
      expect(isPrintRequest(bad)).toBe(false)
    }
  })
})

describe('pdfFileName', () => {
  it('is the page title plus .pdf, without path separators or characters a file system refuses', () => {
    expect(pdfFileName('Meeting notes')).toBe('Meeting notes.pdf')
    expect(pdfFileName('../../etc/passwd')).toBe('etc passwd.pdf')
    expect(pdfFileName('a:b*c?"d"<e>|f\\g\u0000h')).toBe('a b c d e f g h.pdf')
    expect(pdfFileName('   ')).toBe('Untitled page.pdf')
    expect(pdfFileName('...')).toBe('Untitled page.pdf')
    expect(pdfFileName('x'.repeat(500))).toBe(`${'x'.repeat(120)}.pdf`)
  })
})

describe('paperFor', () => {
  it('is Letter in North America and A4 elsewhere', () => {
    expect(paperFor('US')).toBe('Letter')
    expect(paperFor('CA')).toBe('Letter')
    expect(paperFor('AU')).toBe('A4')
    expect(paperFor('')).toBe('A4')
  })
})

describe('registerPrintIpc', () => {
  it('prints through the system dialog with the page backgrounds and pictures', async () => {
    const { call, sender } = setup()
    await expect(call({ kind: 'print' })).resolves.toEqual({ done: true })
    expect(sender.print).toHaveBeenCalledWith({ printBackground: true }, expect.any(Function))
  })

  it('reports a cancelled print as not done', async () => {
    const { call, sender } = setup()
    sender.print.mockImplementation((_o, done) => done(false, 'Print job canceled'))
    await expect(call({ kind: 'print' })).resolves.toEqual({ done: false })
  })

  it('exports a PDF only to the file the person chose, named after the page', async () => {
    const { call, written, chosen, sender, pdf } = setup()
    await expect(call({ kind: 'pdf', title: 'Plans/2026' })).resolves.toEqual({ done: true })
    expect(chosen).toEqual(['Plans 2026.pdf'])
    expect(sender.printToPDF).toHaveBeenCalledWith({ printBackground: true, pageSize: 'A4' })
    expect(written).toEqual([{ path: '/Users/me/Documents/Plans 2026.pdf', bytes: pdf }])
  })

  it('writes nothing, and renders nothing, when the save dialog is cancelled', async () => {
    const { call, written, sender } = setup({ choosePdfPath: () => Promise.resolve(null) })
    await expect(call({ kind: 'pdf', title: 'x' })).resolves.toEqual({ done: false })
    expect(sender.printToPDF).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('refuses a malformed request before any dialog', async () => {
    const { call, chosen, sender } = setup()
    await expect(call({ kind: 'pdf', title: 'x', path: '/tmp/out.pdf' })).rejects.toThrow(/print request/)
    await expect(call()).rejects.toThrow(/print request/)
    expect(chosen).toEqual([])
    expect(sender.print).not.toHaveBeenCalled()
  })
})
