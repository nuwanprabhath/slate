import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFakeConverter } from '../../../../importer/test/fakeOne2html'
import { BackupSource, scanBackup } from './backup'

const FIXTURE = join(__dirname, '../../../../importer/test/fixtures/one/New Section 1.one')
const converter = process.env.SLATE_ONE2HTML

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-backup-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const touch = (rel: string, mtimeSec = 1_700_000_000): string => {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'x')
  utimesSync(file, mtimeSec, mtimeSec)
  return file
}

describe('scanBackup', () => {
  it('keeps the newest dated copy per section, by the date in the name', () => {
    touch('Notes Work/Plans (On 9-3-2025).one', 2_000_000_000)
    touch('Notes Work/Plans (On 21-12-2024).one', 2_100_000_000)
    touch('Notes Work/Plans (On 2-10-2025).one', 1_000_000_000)
    const sections = scanBackup([join(dir, 'Notes Work')])
    expect(sections.map((s) => [s.name, s.date])).toEqual([['Plans', '2025-10-02']])
  })

  it('falls back to mtime for equal dates and treats an undated copy as oldest', () => {
    touch('Nb/A (On 1-1-2025).one', 100)
    const newer = touch('Nb/A (On 1-1-2025) copy.one', 200)
    touch('Nb/B.one', 900)
    touch('Nb/B (On 5-5-2020).one', 100)
    const byName = Object.fromEntries(scanBackup([join(dir, 'Nb')]).map((s) => [s.name, s]))
    expect(byName.B!.date).toBe('2020-05-05')
    expect(Object.keys(byName).sort()).toEqual(['A', 'A copy', 'B'])
    expect(newer).toBeTruthy()
  })

  it('skips the recycle bin and other file types, and names the notebook after the folder without "Notes "', () => {
    touch('Notes Outlook - Personel/Todo (On 1-1-2025).one')
    touch('Notes Outlook - Personel/OneNote_RecycleBin/Gone (On 1-1-2025).one')
    touch('Notes Outlook - Personel/OneNote_RecycleBin.one')
    touch('Notes Outlook - Personel/Open Sections.onetoc2')
    touch('Notes Outlook - Personel/readme.txt')
    const sections = scanBackup([dir])
    expect(sections.map((s) => [s.notebook, s.name])).toEqual([['Outlook - Personel', 'Todo']])
  })

  it('accepts files directly and gives stable ids', () => {
    const file = touch('Plain/Section (On 3-4-2025).one')
    const [a] = scanBackup([file])
    const [b] = scanBackup([join(dir, 'Plain')])
    expect(a!.notebook).toBe('Plain')
    expect(a!.id).toBe(b!.id)
    expect(a!.id.startsWith('backup:')).toBe(true)
  })
})

// "fake" copies the committed converter output, so the child-process plumbing runs everywhere;
// "real" is the one2html binary (SLATE_ONE2HTML), which needs Rust to build.
const converters: Array<[string, () => string | undefined]> = [
  ['fake converter', () => writeFakeConverter(dir)],
  ['real converter', () => converter],
]
describe.each(converters)('BackupSource with the %s', (label, getConverter) => {
  const skip = label === 'real converter' && !converter
  // The real converter is built by `npm run build:one2html`; the fake converter case always runs.
  it.skipIf(skip)('converts the fixture section into pages with content and an image', async () => {
    const file = join(dir, 'Fixture Book', 'New Section 1 (On 27-10-2020).one')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, readFileSync(FIXTURE))
    const sections = scanBackup([join(dir, 'Fixture Book')])
    const source = new BackupSource(sections, { converter: getConverter()! })
    try {
      const tree = await source.listTree()
      expect(tree).toHaveLength(1)
      expect(tree[0]!.name).toBe('Fixture Book')
      expect(tree[0]!.sections.map((s) => s.name)).toEqual(['New Section 1'])
      const pages = await source.listPages(tree[0]!.sections[0]!.id)
      expect(pages.map((p) => p.title)).toEqual(['Test Page'])
      expect(pages[0]!.id.startsWith(`${tree[0]!.sections[0]!.id}/`)).toBe(true)
      const html = await source.pageContent(pages[0]!.id)
      expect(html).toContain('data-absolute-enabled')
      expect(html).toContain('ABCDEF')
      const src = /<img[^>]*src="([^"]+)"/.exec(html)![1]!
      const image = await source.resource(src)
      expect(image.mime).toBe('image/jpeg')
      expect(image.bytes.length).toBeGreaterThan(1000)
      await expect(source.resource('backup-file:/etc/passwd')).rejects.toThrow()
    } finally {
      source.close()
    }
  })

  // The fake copies its canned output for any input, so only the real converter can fail on a bad file.
  it.skipIf(label !== 'real converter' || !converter)('reports a section whose file cannot be converted', async () => {
    const file = touch('Nb/Broken (On 1-1-2025).one')
    const source = new BackupSource(scanBackup([file]), { converter: getConverter()! })
    try {
      const tree = await source.listTree()
      await expect(source.listPages(tree[0]!.sections[0]!.id)).rejects.toThrow()
    } finally {
      source.close()
    }
  })
})

describe('BackupSource without a converter', () => {
  it('explains how to build it', async () => {
    const file = touch('Nb/S (On 1-1-2025).one')
    const source = new BackupSource(scanBackup([file]), { converter: join(dir, 'missing-converter') })
    const tree = await source.listTree()
    await expect(source.listPages(tree[0]!.sections[0]!.id)).rejects.toThrow(/build:one2html/)
    source.close()
  })
})
