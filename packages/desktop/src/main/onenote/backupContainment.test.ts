import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// M4 (FX-4) and FX-16: page files named by the converter's index stay inside the conversion folder,
// and a legitimate name that merely starts with two dots is still served.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
import { BackupSource, scanBackup } from './backup'

let work: string
let outside: string
let source: BackupSource
let sectionId: string
const reads = (): string[] => vi.mocked(fs.readFileSync).mock.calls.map((c) => resolve(String(c[0])))

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'slate-contain-'))
  const tree = join(work, 'tree')
  mkdirSync(join(tree, 'S'), { recursive: true })
  // The conversion folder is a fresh temp dir, so "../outside.html" lands next to it in tmpdir.
  outside = join(tmpdir(), 'outside.html')
  writeFileSync(outside, '<html><body><p>OUTSIDE-SECRET</p></body></html>')
  writeFileSync(join(tree, 'S', 'good.html'), '<html><body><p>good</p></body></html>')
  writeFileSync(join(tree, '..dots.bin'), 'dots')
  const link = (href: string): string => `<li><a class="l1" href="${href}">${href}</a></li>`
  const hrefs = ['S/good.html', '../outside.html', outside, '%2e%2e/outside.html', '..%2foutside.html', 'S/../../outside.html', 'S/..dots.html']
  writeFileSync(join(tree, 'S.html'), `<html><body><nav><ul>${hrefs.map(link).join('')}</ul></nav></body></html>`)
  writeFileSync(join(tree, 'S', '..dots.html'), '<html><body><p>dots page</p></body></html>')
  const conv = join(work, 'conv')
  writeFileSync(conv, `#!/bin/sh\nwhile [ "$1" != "--output" ] && [ $# -gt 0 ]; do shift; done\ncp -R '${tree}/.' "$2"\n`)
  chmodSync(conv, 0o755)
  const input = join(work, 'Book', 'S (On 1-1-2025).one')
  mkdirSync(dirname(input), { recursive: true })
  writeFileSync(input, 'x')
  source = new BackupSource(scanBackup([input]), { converter: conv })
  sectionId = (await source.listTree())[0]!.sections[0]!.id
})
afterAll(() => {
  source.close()
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { force: true })
})

describe('BackupSource page containment', () => {
  it('M4: listPages drops index entries that leave the folder, and nothing outside is read', async () => {
    const pages = await source.listPages(sectionId)
    for (const p of pages) await source.pageContent(p.id).catch(() => '')
    expect(reads().filter((f) => f === outside || f.endsWith('outside.html'))).toEqual([])
    expect(pages.map((p) => p.id.split('/').pop()).sort()).toEqual(['..dots.html', 'good.html'])
  })

  it('FX-16: a name starting with two dots inside the folder is a page and a served resource', async () => {
    const pages = await source.listPages(sectionId)
    const dots = pages.find((p) => p.id.endsWith('..dots.html'))
    expect(dots).toBeDefined()
    await expect(source.pageContent(dots!.id)).resolves.toBeTypeOf('string')
    // The conversion folder itself: the page sits one level below it, in "S".
    const dir = dirname(dirname(reads().find((f) => f.endsWith('..dots.html'))!))
    const got = await source.resource('backup-file:' + join(dir, '..dots.bin'))
    expect(Buffer.from(got.bytes).toString()).toBe('dots')
  })
})
