import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDoc, PageDoc } from '@slate/core'
import { writeFakeConverter } from '../../../../importer/test/fakeOne2html'
import { LOCK_FILE } from '../lock'
import { DocStore } from '../store'
import { runImportCli } from './importCli'

const FIXTURE = join(__dirname, '../../../../importer/test/fixtures/one/New Section 1.one')

const realConverter = process.env.SLATE_ONE2HTML

let dir: string
let backup: string
let userData: string
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-cli-'))
  backup = join(dir, 'Notes Fixture Book')
  mkdirSync(backup)
  writeFileSync(join(backup, 'New Section 1 (On 27-10-2020).one'), readFileSync(FIXTURE))
  userData = join(dir, 'data')
  // The real binary when SLATE_ONE2HTML is set, else a stand-in that copies the committed output.
  process.env.SLATE_ONE2HTML = realConverter ?? writeFakeConverter(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('headless import CLI', () => {
  it('imports the backup into the data folder and prints a JSON report', async () => {
    const run = io()
    const code = await runImportCli(['--backup', backup, '--sections', 'New Section 1', '--user-data', userData], run.io)
    expect(code, run.err.join('\n')).toBe(0)
    const report = JSON.parse(run.out.join(''))
    expect(report).toMatchObject({ phase: 'done', imported: 1, skipped: 0 })
    expect(report.failed).toEqual([])

    const store = new DocStore(join(userData, 'slate.db'), { compact: false })
    try {
      const notebooks = store.list('notebook:')
      expect(notebooks).toHaveLength(1)
      const nb = NotebookDoc.fromUpdates(store.load(notebooks[0]!))
      expect(nb.name).toBe('Fixture Book')
      const page = nb.items().flatMap((i) => i.children).find((p) => p.pageId)!
      expect(page.title).toBe('Test Page')
      const doc = PageDoc.fromUpdates(store.load(`page:${page.pageId}`))
      expect(doc.listBoxes().length).toBeGreaterThan(0)
      expect(store.getMapping('backup:Fixture Book/New Section 1/Test Page.html')).toBeDefined()
    } finally {
      store.close()
    }
  })

  it('a second run skips what was already imported', async () => {
    await runImportCli(['--backup', backup, '--user-data', userData], io().io)
    const run = io()
    expect(await runImportCli(['--backup', backup, '--user-data', userData], run.io)).toBe(0)
    expect(JSON.parse(run.out.join(''))).toMatchObject({ imported: 0, skipped: 1 })
  })

  it('refuses while a live process holds the lock, and imports once it is gone', async () => {
    mkdirSync(userData, { recursive: true })
    // The parent of this test process is alive and is not us.
    writeFileSync(join(userData, LOCK_FILE), String(process.ppid))
    const run = io()
    expect(await runImportCli(['--backup', backup, '--user-data', userData], run.io)).toBe(3)
    expect(run.err.join('\n')).toContain(`pid ${process.ppid}`)
    expect(run.out).toEqual([])

    writeFileSync(join(userData, LOCK_FILE), '2147483646')
    expect(await runImportCli(['--backup', backup, '--user-data', userData], io().io)).toBe(0)
  })

  it('explains bad arguments and empty folders', async () => {
    const bad = io()
    expect(await runImportCli(['--wat'], bad.io)).toBe(2)
    const empty = io()
    expect(await runImportCli(['--backup', join(dir, 'nothing'), '--user-data', userData], empty.io)).toBe(1)
    expect(empty.err.join('')).toContain('No OneNote sections')
  })
})
