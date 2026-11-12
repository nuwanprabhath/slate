import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { writeFakeConverter } from '../../../../importer/test/fakeOne2html'
import { fcRuns, forAll, fuzzTimeout, type Rng } from '../../../test/fuzz'
import { BackupSource, scanBackup } from './backup'

// T-F3D-01..03: BackupSource.resource serves only files inside a conversion folder. It does not
// assert that pageContent stays inside the folder: that fails today (M4) and belongs to FX-4.
const TREE = join(__dirname, '../../../../importer/test/fixtures/one2html')
const PREFIX = 'backup-file:'
const SECRET = 'outside-secret'

let work: string
let evil: string
let source: BackupSource
let convDir: string
let pageFile: string
let pageHtml: string
let pageId: string

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'slate-bfuzz-'))
  const tree = join(work, 'tree')
  cpSync(TREE, tree, { recursive: true })
  mkdirSync(join(tree, 'New Section 1', 'sub'), { recursive: true })
  writeFileSync(join(tree, 'New Section 1', 'sub', 'deep.bin'), 'deep')
  writeFileSync(join(tree, 'New Section 1', '..dots.bin'), 'dots')
  const input = join(work, 'Book', 'S (On 1-1-2025).one')
  mkdirSync(dirname(input), { recursive: true })
  writeFileSync(input, 'x')
  source = new BackupSource(scanBackup([input]), { converter: writeFakeConverter(work, tree) })
  const sectionId = (await source.listTree())[0]!.sections[0]!.id
  pageId = (await source.listPages(sectionId))[0]!.id
  const img = /<img[^>]*src="backup-file:([^"]+)"/.exec(await source.pageContent(pageId))![1]!
  // The image sits in <conversion dir>/New Section 1/.
  pageFile = join(dirname(img), 'Test Page.html')
  convDir = dirname(dirname(img))
  pageHtml = readFileSync(pageFile, 'utf8')
  // A sibling whose name starts with the conversion folder's name, and a file next to the folder.
  evil = convDir + '-evil'
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(evil, SECRET), SECRET)
  writeFileSync(join(dirname(convDir), SECRET), SECRET)
})

afterAll(() => {
  source?.close()
  rmSync(work, { recursive: true, force: true })
  if (evil) rmSync(evil, { recursive: true, force: true })
  if (convDir) rmSync(join(dirname(convDir), SECRET), { force: true })
})

const insideNames = ['New Section 1/testimages_screenshot.jpg', 'New Section 1/sub/deep.bin', 'New Section 1/Test Page.html', 'New Section 1/../New Section 1/sub/deep.bin']

const hostile = (rng: Rng): string => {
  const tail = rng.pick([SECRET, 'etc/passwd', 'New Section 1/testimages_screenshot.jpg', ''])
  const up = '../'.repeat(rng.int(1, 6))
  const enc = rng.pick(['%2e%2e/', '%2E%2E%2F', '..%2f', '..\\', '....//', '.%2e/'])
  return rng.pick([
    PREFIX + convDir + '/' + up + tail,
    PREFIX + convDir + '/New Section 1/' + up + tail,
    PREFIX + '/' + tail,
    PREFIX + evil + '/' + SECRET,
    PREFIX + convDir + rng.string(4) + '/' + tail,
    PREFIX + convDir + '/' + enc.repeat(rng.int(1, 4)) + tail,
    PREFIX + convDir + sep + '..' + sep + SECRET,
    PREFIX + dirname(convDir) + '/' + SECRET,
    PREFIX + convDir,
    PREFIX + tail,
    PREFIX + rng.string(30),
    'file://' + dirname(convDir) + '/' + SECRET,
    dirname(convDir) + '/' + SECRET,
    rng.string(40),
  ])
}

const outcome = async (url: string): Promise<Uint8Array | null> => {
  try {
    return (await source.resource(url)).bytes
  } catch {
    return null
  }
}

const generate = (runs: number): Rng[] => {
  const rngs: Rng[] = []
  forAll('generate', (rng) => void rngs.push(rng), runs)
  return rngs
}

describe('BackupSource.resource boundary', () => {
  it('T-F3D-01: refuses every address that resolves outside a conversion folder', async () => {
    let refused = 0
    for (const rng of generate(fcRuns(2).numRuns)) {
      const url = hostile(rng)
      const got = await outcome(url)
      const path = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : ''
      const resolved = resolve(path)
      if (!(path.startsWith(sep) && resolved.startsWith(convDir + sep))) {
        expect(got, `served ${JSON.stringify(url)}`).toBeNull()
        refused++
      } else if (got) {
        expect(Buffer.from(got).equals(readFileSync(resolved))).toBe(true)
      }
    }
    expect(refused).toBeGreaterThan(0)
  }, fuzzTimeout(3_000))

  it('T-F3D-02: serves the files inside the folder, byte for byte', async () => {
    for (const name of insideNames) {
      const got = await outcome(PREFIX + convDir + '/' + name)
      expect(got, name).not.toBeNull()
      expect(Buffer.from(got!).equals(readFileSync(resolve(convDir, name)))).toBe(true)
    }
  })

  it('T-F3D-03: an img address from the page is refused when fetched unless it resolves inside', async () => {
    let checked = 0
    for (const rng of generate(fcRuns(20).numRuns)) {
      const src = rng.pick([
        () => '../'.repeat(rng.int(1, 5)) + SECRET,
        () => '../' + (convDir.split(sep).pop() ?? '') + '-evil/' + SECRET,
        () => '%2e%2e/' + SECRET,
        () => 'sub/../../' + SECRET,
        () => '/' + SECRET,
        () => dirname(convDir) + '/' + SECRET,
        () => 'testimages_screenshot.jpg',
        () => 'sub/deep.bin',
        // encodeURI throws on a lone surrogate, so build an escaped string from ASCII only.
        () => Array.from({ length: rng.int(0, 8) }, () => rng.pick(['%', '%2', '%zz', '..', '/', '\\', 'a', '%00', '%C3%A9'])).join(''),
      ])()
      writeFileSync(pageFile, pageHtml.replace('src="testimages_screenshot.jpg"', `src="${src.replace(/"/g, '&quot;')}"`))
      let html: string
      try {
        html = await source.pageContent(pageId)
      } catch {
        continue // a malformed escape is a clean refusal, not a leak
      }
      const m = /<img[^>]*src="([^"]*)"/.exec(html)
      if (!m) continue
      const url = m[1]!.replace(/&amp;/g, '&')
      const got = await outcome(url)
      const path = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : ''
      if (got) expect(resolve(path).startsWith(convDir + sep), `served ${url}`).toBe(true)
      checked++
    }
    writeFileSync(pageFile, pageHtml)
    expect(checked).toBeGreaterThan(0)
  }, fuzzTimeout(3_000))
})
