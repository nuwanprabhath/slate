import type { ElectronApplication } from '@playwright/test'
import { inflateSync } from 'node:zlib'

/**
 * Enough of a PDF reader for Chromium's output: page count, and the text of every font decoded
 * through its ToUnicode map. Glyph runs are joined without spaces, so look for single words.
 */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length
}

/** Each object's dictionary and, when it has one, its stream decoded. */
function objects(pdf: Buffer): Map<string, { dict: string; stream: string }> {
  const out = new Map<string, { dict: string; stream: string }>()
  const text = pdf.toString('latin1')
  for (const m of text.matchAll(/(\d+) 0 obj\b/g)) {
    const at = m.index + m[0].length
    const end = text.indexOf('endobj', at)
    const body = text.slice(at, end)
    const s = body.indexOf('stream')
    if (s < 0) {
      out.set(m[1]!, { dict: body, stream: '' })
      continue
    }
    const start = at + s + 6 + (text[at + s + 6] === '\r' ? 2 : 1)
    const raw = pdf.subarray(start, at + body.lastIndexOf('endstream'))
    let stream: string
    try {
      stream = inflateSync(raw).toString('latin1')
    } catch {
      stream = raw.toString('latin1')
    }
    out.set(m[1]!, { dict: body.slice(0, s), stream })
  }
  return out
}

const utf16 = (hex: string) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)))

function toUnicode(cmap: string): { width: number; map: Map<number, string> } {
  const map = new Map<number, string>()
  const range = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(cmap)
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const [, src, dst] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(src!, 16), utf16(dst!))
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const [, lo, hi, dst] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const first = utf16(dst!)
      for (let c = parseInt(lo!, 16), i = 0; c <= parseInt(hi!, 16); c++, i++) map.set(c, first.slice(0, -1) + String.fromCharCode(first.charCodeAt(first.length - 1) + i))
    }
  }
  return { width: range ? range[1]!.length : 4, map }
}

/** The page text, one line per text object, each glyph run read through its font's ToUnicode map. */
export function pdfText(pdf: Buffer): string {
  const objs = objects(pdf)
  const fonts = new Map<string, ReturnType<typeof toUnicode>>()
  for (const { dict } of objs.values()) {
    for (const [, list] of dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const [, name, ref] of list!.matchAll(/\/([^\s/]+)\s+(\d+) 0 R/g)) {
        const cmapRef = /\/ToUnicode\s+(\d+) 0 R/.exec(objs.get(ref!)?.dict ?? '')?.[1]
        const cmap = cmapRef === undefined ? undefined : objs.get(cmapRef)?.stream
        if (cmap !== undefined) fonts.set(name!, toUnicode(cmap))
      }
    }
  }
  let out = ''
  for (const { stream } of objs.values()) {
    if (!/\bBT\b/.test(stream)) continue
    let font: ReturnType<typeof toUnicode> | undefined
    for (const [, name, hex, et] of stream.matchAll(/\/([^\s/]+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f]+)>|\b(ET)\b/g)) {
      if (name !== undefined) font = fonts.get(name)
      else if (et !== undefined) out += '\n'
      else if (font && hex !== undefined) out += (hex.match(new RegExp(`.{${String(font.width)}}`, 'g')) ?? []).map((c) => font.map.get(parseInt(c, 16)) ?? '').join('')
    }
  }
  return out
}

/**
 * Answers the next "Export Page as PDF" save dialog with `filePath` once `release` is called, so a
 * test can look at the window while the page is laid out for print. No dialog ever opens.
 */
export async function holdSaveDialog(app: ElectronApplication, filePath: string | null): Promise<{ release: () => Promise<void>; asked: () => Promise<string | null> }> {
  await app.evaluate(({ dialog }, path) => {
    const g = globalThis as { slatePrintRelease?: () => void; slatePrintAsked?: string }
    const answer = (...args: unknown[]) =>
      new Promise((resolve) => {
        const options = args[args.length - 1] as { defaultPath?: string }
        g.slatePrintAsked = options.defaultPath ?? ''
        g.slatePrintRelease = () => resolve(path === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: path })
      })
    Object.assign(dialog, { showSaveDialog: answer })
  }, filePath)
  return {
    release: () => app.evaluate(() => (globalThis as { slatePrintRelease?: () => void }).slatePrintRelease?.()),
    asked: () => app.evaluate(() => (globalThis as { slatePrintAsked?: string }).slatePrintAsked ?? null),
  }
}

/** Replaces every webContents' print() so File → Print never reaches the system dialog; returns what it was asked. */
export async function stubSystemPrint(app: ElectronApplication): Promise<() => Promise<unknown[]>> {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as { slatePrintCalls?: unknown[] }
    g.slatePrintCalls = []
    const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0]!.webContents) as { print: unknown }
    proto.print = (options: unknown, done: (ok: boolean, reason: string) => void) => {
      g.slatePrintCalls!.push(options)
      done(false, 'cancelled')
    }
  })
  return () => app.evaluate(() => (globalThis as { slatePrintCalls?: unknown[] }).slatePrintCalls ?? [])
}
