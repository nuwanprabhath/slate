import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { normalizeOne2HtmlPage, parseOne2HtmlSection, type GraphSource, type OneNoteNotebook, type OneNotePageMeta } from '@slate/importer'

/** Mapping keys of backup imports start with this, so they never collide with Graph ids. */
export const BACKUP_PREFIX = 'backup:'
const RECYCLE_BIN = 'OneNote_RecycleBin'
const RESOURCE_PREFIX = 'backup-file:'
const DATED = /^(.*?)\s*\(On (\d{1,2})-(\d{1,2})-(\d{4})\)\s*(.*)$/

export interface BackupSection {
  /** Stable across scans: `backup:<notebook>/<section name>`. */
  id: string
  name: string
  notebook: string
  /** ISO date from the file name (day-month-year there), or '' for an undated file. */
  date: string
  path: string
  mtimeMs: number
}

function parseName(file: string): { name: string; date: string } {
  const stem = basename(file, extname(file))
  const m = DATED.exec(stem)
  if (!m) return { name: stem, date: '' }
  const date = `${m[4]}-${m[3]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  return { name: [m[1], m[5]].filter(Boolean).join(' ').trim() || stem, date }
}

function collect(path: string, out: string[]): void {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    if (basename(path) === RECYCLE_BIN) return
    for (const entry of readdirSync(path).sort()) collect(join(path, entry), out)
  } else if (/\.(one|onepkg)$/i.test(path) && !basename(path).startsWith(RECYCLE_BIN)) out.push(path)
}

/** Sections found in backup files and folders, newest dated copy per section name in each notebook. */
export function scanBackup(paths: string[]): BackupSection[] {
  const files: string[] = []
  for (const p of paths) collect(resolve(p), files)
  const best = new Map<string, BackupSection>()
  for (const path of [...new Set(files)]) {
    const { name, date } = parseName(path)
    const notebook = basename(dirname(path)).replace(/^Notes\s+/, '')
    const candidate: BackupSection = { id: `${BACKUP_PREFIX}${notebook}/${name}`, name, notebook, date, path, mtimeMs: statSync(path).mtimeMs }
    const held = best.get(candidate.id)
    // ISO dates compare as strings; an undated file ('') is the oldest.
    if (!held || candidate.date > held.date || (candidate.date === held.date && candidate.mtimeMs > held.mtimeMs)) best.set(candidate.id, candidate)
  }
  return [...best.values()].sort((a, b) => a.notebook.localeCompare(b.notebook) || a.name.localeCompare(b.name))
}

/** The converter to run: `SLATE_ONE2HTML`, else the binary shipped with (or built next to) the app. */
export function converterPath(resourcesDirs: string[]): string {
  if (process.env.SLATE_ONE2HTML) return process.env.SLATE_ONE2HTML
  const file = `one2html-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
  return resourcesDirs.map((d) => join(d, file)).find((p) => existsSync(p)) ?? join(resourcesDirs[0] ?? '.', file)
}

/** Where the app looks for the converter: the packaged `converter` resource dir, else the checkout's. */
export function defaultConverterDirs(): string[] {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  // out/main/*.js sits two levels below the package root, in dev and packaged alike.
  return [...(resources ? [join(resources, 'converter')] : []), join(__dirname, '../../resources/bin')]
}

function sniffMime(bytes: Uint8Array): string {
  const at = (i: number): number => bytes[i] ?? 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif'
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp'
  if (at(0) === 0x52 && at(1) === 0x49 && at(8) === 0x57 && at(9) === 0x45) return 'image/webp'
  if (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a) return 'image/tiff'
  return 'application/octet-stream'
}

interface Converted {
  dir: string
  pages: Array<{ title: string; level: number; file: string }>
}

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((done, fail) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }, (error, _out, stderr) => {
      if (!error) return done()
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') fail(new Error(`The one2html converter was not found at ${command}. Build it with "npm run build:one2html" (needs Rust), or set SLATE_ONE2HTML.`))
      else fail(new Error(`one2html failed: ${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`))
    })
  })

/** Backup sections as a OneNote source: each is converted once by `one2html` into a temp dir. */
export class BackupSource implements GraphSource {
  private readonly bySection = new Map<string, BackupSection>()
  private readonly converted = new Map<string, Promise<Converted>>()
  private readonly pageFiles = new Map<string, string>()
  private readonly dirs = new Set<string>()

  constructor(private readonly sections: BackupSection[], private readonly options: { converter: string }) {
    for (const s of sections) this.bySection.set(s.id, s)
  }

  async listTree(): Promise<OneNoteNotebook[]> {
    const notebooks = new Map<string, OneNoteNotebook>()
    for (const s of this.sections) {
      const id = `${BACKUP_PREFIX}nb:${s.notebook}`
      const nb = notebooks.get(id) ?? { id, name: s.notebook, sectionGroups: [], sections: [] }
      nb.sections.push({ id: s.id, name: s.name, lastModified: new Date(s.mtimeMs).toISOString() })
      notebooks.set(id, nb)
    }
    return [...notebooks.values()]
  }

  async listPages(sectionId: string): Promise<OneNotePageMeta[]> {
    const section = this.bySection.get(sectionId)
    if (!section) throw new Error(`Unknown backup section ${sectionId}`)
    const converted = await this.convert(section)
    const lastModified = new Date(section.mtimeMs).toISOString()
    return converted.pages.map((p, order) => {
      const id = `${sectionId}/${basename(p.file)}`
      this.pageFiles.set(id, join(converted.dir, p.file))
      return { id, title: p.title, level: p.level, order, lastModified }
    })
  }

  async pageContent(pageId: string): Promise<string> {
    const file = this.pageFiles.get(pageId)
    if (!file) throw new Error(`Unknown backup page ${pageId}`)
    const pageDir = dirname(file)
    return normalizeOne2HtmlPage(readFileSync(file, 'utf8'), { rewriteSrc: (src) => RESOURCE_PREFIX + resolve(pageDir, decodeURI(src)) })
  }

  async resource(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const file = url.startsWith(RESOURCE_PREFIX) ? url.slice(RESOURCE_PREFIX.length) : ''
    // Only files inside a conversion directory: page HTML comes from a file the user picked.
    const inside = [...this.dirs].some((d) => !relative(d, file).startsWith('..') && file.startsWith(d + sep))
    if (!inside) throw new Error('Not a converted backup file')
    const bytes = new Uint8Array(readFileSync(file))
    return { bytes, mime: sniffMime(bytes) }
  }

  close(): void {
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true })
    this.dirs.clear()
    this.converted.clear()
    this.pageFiles.clear()
  }

  private convert(section: BackupSection): Promise<Converted> {
    const key = `${section.path}\0${section.mtimeMs}`
    let job = this.converted.get(key)
    if (!job) {
      job = this.doConvert(section)
      this.converted.set(key, job)
      // A failed conversion is not cached, so a retry runs it again.
      job.catch(() => this.converted.delete(key))
    }
    return job
  }

  private async doConvert(section: BackupSection): Promise<Converted> {
    const dir = mkdtempSync(join(tmpdir(), 'slate-one2html-'))
    this.dirs.add(dir)
    await run(this.options.converter, ['--input', section.path, '--output', dir])
    const index = readdirSync(dir).find((f) => f.endsWith('.html'))
    if (!index) throw new Error('The converter produced no pages')
    return { dir, pages: parseOne2HtmlSection(readFileSync(join(dir, index), 'utf8')) }
  }
}
