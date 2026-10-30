import { describe, expect, it, vi } from 'vitest'
import { CH } from '../shared/ipc'
import type { Channel, Handler, IpcRegistrar } from './ipcGuard'
import { logHandlers } from './log/ipcLog'
import type { Logger } from './log/logger'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }))
const { electronPrintHost, isPrintRequest, paperFor, pdfFileName, registerPrintIpc, writeOwnerOnly } = await import('./print')
type Host = Parameters<typeof registerPrintIpc>[1]

const TITLE = 'Meeting with Dr Smith re biopsy'

function setup(host: Partial<Host> = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  const logged: unknown[] = []
  const logger = { error: (...args: unknown[]) => void logged.push(args) } as unknown as Logger
  const written: Array<{ path: string; bytes: Uint8Array }> = []
  const chosen: string[] = []
  const shown: string[] = []
  const full: Host = {
    choosePdfPath: (_sender, name) => (chosen.push(name), Promise.resolve(`/Users/me/Documents/${name}`)),
    writePdf: (path, bytes) => (written.push({ path, bytes }), Promise.resolve()),
    paper: () => 'A4',
    isOpen: () => true,
    refusePath: () => null,
    showError: (_sender, message) => void shown.push(message),
    ...host,
  }
  registerPrintIpc(logHandlers({ ...ipc, handle: (channel: string, handler: Handler) => ipc.handle(channel as Channel, handler) }, logger), full)
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46])
  const sender = {
    id: 7,
    isDestroyed: vi.fn(() => false),
    print: vi.fn((_opts: unknown, done: (ok: boolean, reason: string) => void) => done(true, '')),
    printToPDF: vi.fn(() => Promise.resolve(pdf)),
  }
  const call = (...args: unknown[]) => handlers.get(CH.pagePrint)!({ sender } as never, ...args)
  return { handlers, written, chosen, shown, logged, sender, call, pdf }
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

  it('cuts a long title by characters, never inside an emoji, and drops bidi and other format controls', () => {
    const name = pdfFileName(`${'x'.repeat(119)}\u{1F600}tail`)
    expect(name).toBe(`${'x'.repeat(119)}\u{1F600}.pdf`)
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(pdfFileName('invoice\u202Efdp.exe')).toBe('invoice fdp.exe.pdf')
    expect(pdfFileName('a\u2066b\u2069c\u200Ed\u200Fe\u202Af')).toBe('a b c d e f.pdf')
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

  it('a failed save tells the person with only the error code, and the page title reaches neither the log nor the renderer', async () => {
    const failure = Object.assign(new Error(`ENOENT: no such file or directory, open '/Volumes/USB/${TITLE}.pdf'`), { code: 'ENOENT' })
    const { call, shown, logged } = setup({ writePdf: () => Promise.reject(failure) })
    const result = await call({ kind: 'pdf', title: TITLE })
    expect(result).toEqual({ done: false, error: 'ENOENT' })
    expect(shown).toEqual(['Could not save the PDF (ENOENT).'])
    expect(JSON.stringify([result, shown, logged])).not.toContain('Smith')
  })

  it('a failed render is reported the same way, without its message', async () => {
    const { call, shown, logged, sender, written } = setup()
    sender.printToPDF.mockImplementation(() => Promise.reject(new Error(`render failed for ${TITLE}`)))
    const result = await call({ kind: 'pdf', title: TITLE })
    expect(result).toEqual({ done: false, error: 'unknown' })
    expect(shown).toEqual(['Could not save the PDF (unknown).'])
    expect(written).toEqual([])
    expect(JSON.stringify([result, shown, logged])).not.toContain('Smith')
  })

  it('renders and writes nothing when the vault locked or the window closed while the save dialog was open', async () => {
    let open = true
    const locked = setup({ isOpen: () => open, choosePdfPath: (_s, name) => ((open = false), Promise.resolve(`/tmp/${name}`)) })
    await expect(locked.call({ kind: 'pdf', title: 'x' })).resolves.toEqual({ done: false })
    expect(locked.sender.printToPDF).not.toHaveBeenCalled()

    const closed = setup()
    closed.sender.isDestroyed.mockReturnValue(true)
    await expect(closed.call({ kind: 'pdf', title: 'x' })).resolves.toEqual({ done: false })
    expect(closed.sender.printToPDF).not.toHaveBeenCalled()

    // Locked while the page was being rendered: the bytes are dropped, not written.
    open = true
    const midway = setup({ isOpen: () => open })
    midway.sender.printToPDF.mockImplementation(() => ((open = false), Promise.resolve(midway.pdf)))
    await expect(midway.call({ kind: 'pdf', title: 'x' })).resolves.toEqual({ done: false })
    expect(midway.written).toEqual([])
  })

  it('refuses a file inside Slate\'s data folder and says why', async () => {
    const { call, written, shown, sender } = setup({ refusePath: () => 'Choose a folder outside Slate’s data folder.' })
    await expect(call({ kind: 'pdf', title: 'x' })).resolves.toEqual({ done: false })
    expect(shown).toEqual(['Choose a folder outside Slate’s data folder.'])
    expect(sender.printToPDF).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('allows one print or export at a time per window: a second request gets no dialog', async () => {
    let answer: (path: string | null) => void = () => {}
    const { call, chosen, sender } = setup({ choosePdfPath: (_s, name) => (chosen.push(name), new Promise((r) => (answer = r))) })
    const first = call({ kind: 'pdf', title: 'one' })
    await expect(call({ kind: 'pdf', title: 'two' })).resolves.toEqual({ done: false })
    await expect(call({ kind: 'print' })).resolves.toEqual({ done: false })
    expect(chosen).toEqual(['one.pdf'])
    expect(sender.print).not.toHaveBeenCalled()
    answer(null)
    await expect(first).resolves.toEqual({ done: false })
    await expect(call({ kind: 'print' })).resolves.toEqual({ done: true })
  })
})

describe('electronPrintHost', () => {
  it('still writes the PDF where the disk has no owner permissions (FAT and exFAT refuse chmod)', async () => {
    const written: Uint8Array[] = []
    const eperm = () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
    const handle = (owner: number) => ({
      chmod: eperm,
      stat: () => Promise.resolve({ uid: owner }),
      writeFile: (bytes: Uint8Array) => (written.push(bytes), Promise.resolve()),
      close: () => Promise.resolve(),
    })
    // A FAT stick on Linux is mounted with the person's own uid: chmod fails, the file is theirs.
    await writeOwnerOnly('/media/usb/page.pdf', Uint8Array.from([7]), () => Promise.resolve(handle(501)), 501)
    expect(written).toEqual([Uint8Array.from([7])])
    const other = { ...handle(501), chmod: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) }
    await expect(writeOwnerOnly('/x.pdf', Uint8Array.from([7]), () => Promise.resolve(other), 501)).rejects.toThrow('EIO')
  })

  it("refuses to replace another account's file, which chmod cannot narrow (EPERM)", async () => {
    const written: Uint8Array[] = []
    const theirs = {
      chmod: () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })),
      stat: () => Promise.resolve({ uid: 999 }),
      writeFile: (bytes: Uint8Array) => (written.push(bytes), Promise.resolve()),
      close: () => Promise.resolve(),
    }
    await expect(writeOwnerOnly('/Users/Shared/page.pdf', Uint8Array.from([7]), () => Promise.resolve(theirs), 501)).rejects.toThrow('EPERM')
    expect(written).toEqual([])
  })

  it('writes the PDF readable by its owner only, and refuses a path inside the data folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-print-'))
    try {
      const dataDir = join(dir, 'Slate')
      const host = electronPrintHost(dataDir, () => true)
      const out = join(dir, 'page.pdf')
      await host.writePdf(out, Uint8Array.from([1, 2, 3]))
      expect(statSync(out).mode & 0o777).toBe(0o600)
      // Replacing a file the person already had: writeFile's mode only applies when it creates the file.
      const old = join(dir, 'old.pdf')
      writeFileSync(old, 'x', { mode: 0o644 })
      chmodSync(old, 0o644)
      await host.writePdf(old, Uint8Array.from([4, 5]))
      expect(statSync(old).mode & 0o777).toBe(0o600)
      expect(readFileSync(old)).toEqual(Buffer.from([4, 5]))
      expect(host.refusePath(join(dataDir, 'git-sync', 'abc', 'page.pdf'))).toBe('Choose a folder outside Slate’s data folder.')
      expect(host.refusePath(out)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
