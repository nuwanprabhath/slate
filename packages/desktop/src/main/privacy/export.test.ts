import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, NotebookDoc, PageDoc } from '@slate/core'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { FileBlobStore } from '../blobs'
import { DocStore } from '../store'
import { exportFolderName, safeName, writeExport, type ExportManifest, type ExportSource } from './export'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'slate-export-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const NOW = new Date('2026-11-26T10:30:00.123Z')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function fixture() {
  const data = temp()
  const store = new DocStore(join(data, 'slate.db'), { compact: false })
  const blobs = new FileBlobStore(join(data, 'blobs'))
  const url = blobs.put(PNG, 'image/png')
  const nb = NotebookDoc.create('Work / Notes')
  const group = nb.addSectionGroup('Group')
  const section = nb.addSection('Plans?', group)
  const a = nb.addPage(section, 'Launch plan')
  const b = nb.addPage(section, 'Launch plan')
  nb.setAccess(section, 'read')
  const page = new PageDoc()
  page.addBox({ x: 0, y: 100, width: 200, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second box' }] }] })
  page.addBox({ x: 0, y: 0, width: 200, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first box' }] }, { type: 'image', attrs: { src: url, alt: 'pic' } }] })
  const priv = page.addBox({ x: 0, y: 200, width: 200, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'private words' }] }] })
  page.updateBox(priv, { private: true })
  store.append(`page:${a.pageId}`, page.doc.export({ mode: 'snapshot' }))
  store.append(`page:${b.pageId}`, new PageDoc().doc.export({ mode: 'snapshot' }))
  const orphan = new PageDoc()
  orphan.addBox({ x: 0, y: 0, width: 100, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'lost page' }] }] })
  store.append('page:00000000-0000-4000-8000-000000000001', orphan.doc.export({ mode: 'snapshot' }))
  store.append(`notebook:${newId()}`, nb.doc.export({ mode: 'snapshot' }))
  store.appendAudit({ tool: 'search', target: '[5 chars]', outcome: 'ok' })
  const src: ExportSource = { store, blobs, settings: { ...DEFAULT_SETTINGS, deviceId: 'laptop' }, securityLog: () => 'unlock ok\n', appVersion: '9.9.9', now: NOW }
  return { store, blobs, src, url, a, b }
}

describe('writeExport (GDPR-05)', () => {
  it('writes every page as Markdown, every image, the settings, the AI record, the security log and a manifest', async () => {
    const { store, src, a, b } = fixture()
    const parent = temp()
    const report = await writeExport(parent, src)
    store.close()
    expect(report.folder).toBe(join(parent, 'Slate export 2026-11-26T10-30-00Z'))
    expect(report.pages).toBe(3)
    expect(report.images).toBe(1)
    const manifest = JSON.parse(readFileSync(join(report.folder, 'manifest.json'), 'utf8')) as ExportManifest
    expect(manifest).toMatchObject({ format: 'slate-export', version: 1, exportedAt: NOW.toISOString(), appVersion: '9.9.9', errors: [] })
    expect(manifest.notebooks).toHaveLength(1)
    const [section] = manifest.notebooks[0]!.sections
    expect(section).toMatchObject({ title: 'Plans?', access: 'read' })
    expect(section!.pages.map((p) => p.id)).toEqual([a.pageId, b.pageId])
    const first = section!.pages[0]!
    expect(first.file).toBe(`notebooks/Work _ Notes/Plans_/Launch plan-${a.pageId.slice(0, 8)}.md`)
    const md = readFileSync(join(report.folder, ...first.file.split('/')), 'utf8')
    // Reading order (top box first), private boxes included, images relinked into the export.
    expect(md.indexOf('first box')).toBeLessThan(md.indexOf('second box'))
    expect(md).toContain('private words')
    expect(md).toContain(`](../../../images/${first.images[0]!})`)
    expect(md).not.toContain('slate-blob:')
    expect(md.startsWith('# Launch plan\n')).toBe(true)
    expect(readFileSync(join(report.folder, 'images', first.images[0]!))).toEqual(Buffer.from(PNG))
    expect(manifest.unfiled.map((p) => p.file)).toEqual(['unfiled/Unfiled page-00000000.md'])
    expect(readFileSync(join(report.folder, 'unfiled', 'Unfiled page-00000000.md'), 'utf8')).toContain('lost page')
    expect(JSON.parse(readFileSync(join(report.folder, 'settings.json'), 'utf8'))).toMatchObject({ deviceId: 'laptop' })
    expect(JSON.parse(readFileSync(join(report.folder, 'ai-audit.json'), 'utf8'))).toEqual([expect.objectContaining({ tool: 'search', target: '[5 chars]' })])
    expect(readFileSync(join(report.folder, 'security-log.txt'), 'utf8')).toBe('unlock ok\n')
    expect(report.bytes).toBeGreaterThan(PNG.byteLength)
  })

  it('makes files 0600 and folders 0700', async () => {
    const { store, src } = fixture()
    const report = await writeExport(temp(), src)
    store.close()
    expect(statSync(report.folder).mode & 0o777).toBe(0o700)
    expect(statSync(join(report.folder, 'images')).mode & 0o777).toBe(0o700)
    expect(statSync(join(report.folder, 'manifest.json')).mode & 0o777).toBe(0o600)
  })

  it('never overwrites: an existing export folder is refused and left as it was', async () => {
    const { store, src } = fixture()
    const parent = temp()
    mkdirSync(join(parent, exportFolderName(NOW)))
    await expect(writeExport(parent, src)).rejects.toThrow(/EEXIST/)
    store.close()
    expect(readdirSync(join(parent, exportFolderName(NOW)))).toEqual([])
  })

  it('carries on past an unreadable page and a missing image, listing each in manifest.errors', async () => {
    const { store, src, a } = fixture()
    const broken: ExportSource = {
      ...src,
      store: { list: (p) => store.list(p), listAudit: (n) => store.listAudit(n), load: (id) => (id === `page:${a.pageId}` ? [new Uint8Array([1, 2, 3])] : store.load(id)) },
      blobs: { list: () => [], has: () => false, read: () => new Uint8Array() },
      securityLog: () => {
        throw new Error('not implemented')
      },
    }
    const report = await writeExport(temp(), broken)
    store.close()
    const items = report.manifest.errors.map((e) => e.item)
    expect(items).toContain(`page:${a.pageId}`)
    expect(items).toContain('security-log.txt')
    expect(report.pages).toBe(2)
    expect(existsSync(join(report.folder, 'manifest.json'))).toBe(true)
  })
})

describe('safeName', () => {
  it('keeps [A-Za-z0-9 ._-], drops leading dots, caps at 80 and never returns empty', () => {
    expect(safeName('a/b\\c:d*?')).toBe('a_b_c_d__')
    expect(safeName('../etc')).toBe('_etc')
    expect(safeName('...')).toBe('Untitled')
    expect(safeName('')).toBe('Untitled')
    expect(safeName('x'.repeat(200))).toHaveLength(80)
  })
})
