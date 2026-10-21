import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine } from '../src/engine'
import { GitDrive } from '../src/gitDrive'
import { nodeGitRunner, tokenEnv } from '../src/gitRunner'
import { addTextBox, appendText, boxText, editPage, memoryLocal } from './memoryLocal'

const PAGE = 'page:44444444-4444-4444-8444-444444444444'
const run = nodeGitRunner()
const temps: string[] = []

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-git-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bareRepo(): string {
  const dir = temp()
  execFileSync('git', ['init', '--bare', '--initial-branch=main', dir])
  return `file://${dir}`
}

function drive(remoteUrl: string, name: string, authEnv = async () => ({})): GitDrive {
  return new GitDrive({ run, dir: join(temp(), 'repo'), remoteUrl, branch: 'main', authEnv, author: { name, email: `${name}@test.local` } })
}

function device(remoteUrl: string, id: string) {
  const local = memoryLocal()
  const remote = drive(remoteUrl, id)
  return { local, remote, engine: new SyncEngine({ local, remote, deviceId: id, deviceName: id, compactAfter: 2 }) }
}

const log = (url: string) => execFileSync('git', ['--git-dir', url.slice('file://'.length), 'log', '--format=%s', 'main']).toString()

describe('GitDrive', { timeout: 30_000 }, () => {
  it('gives an empty remote a README commit', async () => {
    const url = bareRepo()
    const d = drive(url, 'A')
    expect(await d.delta(null)).toMatchObject({ items: [{ path: 'README.md', isFile: true, deleted: false }] })
    expect(log(url)).toContain('slate: initialise')
  })

  it('converges two devices through one bare repo', async () => {
    const url = bareRepo()
    const a = device(url, 'A')
    const b = device(url, 'B')
    const [x, y] = editPage(a.local, PAGE, (p) => [addTextBox(p, 'x'), addTextBox(p, 'y', { x: 0, y: 300 })])
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    editPage(a.local, PAGE, (p) => appendText(p, x!, ' from A'))
    editPage(b.local, PAGE, (p) => appendText(p, y!, ' from B'))
    for (let i = 0; i < 2; i++) {
      expect((await a.engine.syncOnce()).status).toBe('idle-synced')
      expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    }
    expect(a.local.doc(PAGE).toJSON()).toEqual(b.local.doc(PAGE).toJSON())
    const page = new PageDoc(b.local.doc(PAGE))
    expect([boxText(page, x!), boxText(page, y!)]).toEqual(['x from A', 'y from B'])
    expect(log(url)).toMatch(/slate: A \(\d+ files\)/)
    expect(log(url)).toMatch(/slate: B \(\d+ files\)/)
  })

  it('makes no commit for an idle sync that only refreshes the device record', async () => {
    const url = bareRepo()
    const a = device(url, 'A')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'x'))
    await a.engine.syncOnce()
    const commits = log(url).trim().split('\n').length
    for (let i = 0; i < 2; i++) expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(log(url).trim().split('\n').length).toBe(commits)
    editPage(a.local, PAGE, (p) => addTextBox(p, 'y'))
    await a.engine.syncOnce()
    expect(log(url).trim().split('\n').length).toBe(commits + 1)
  })

  it('rebases concurrent pushes so both land', async () => {
    const url = bareRepo()
    const a = drive(url, 'A')
    const b = drive(url, 'B')
    await a.delta(null)
    await b.delta(null)
    await a.upload('devices/A.json', new TextEncoder().encode('{}'))
    await b.upload('devices/B.json', new TextEncoder().encode('{}'))
    await Promise.all([a.flush(), b.flush()])
    const paths = (await drive(url, 'C').delta(null)).items.map((i) => i.path)
    expect(paths).toEqual(expect.arrayContaining(['devices/A.json', 'devices/B.json']))
  })

  it('commits a compaction removal and reports it as deleted', async () => {
    const url = bareRepo()
    const a = drive(url, 'A')
    const b = drive(url, 'B')
    await a.upload('docs/page_1/A/00000001.chunk', new Uint8Array([1]))
    await a.flush()
    const first = await b.delta(null)
    expect(first.items.map((i) => i.path)).toContain('docs/page_1/A/00000001.chunk')
    expect(await b.download('docs/page_1/A/00000001.chunk')).toEqual(new Uint8Array([1]))
    await a.upload('docs/page_1/A/snapshot-00000002.bin', new Uint8Array([2]))
    await a.remove('docs/page_1/A/00000001.chunk')
    await a.flush()
    const next = await b.delta(first.cursor)
    expect(next.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'docs/page_1/A/00000001.chunk', deleted: true }),
        expect.objectContaining({ path: 'docs/page_1/A/snapshot-00000002.bin', deleted: false })
      ])
    )
    await expect(b.download('docs/page_1/A/00000001.chunk')).rejects.toMatchObject({ status: 404 })
  })

  it('reports an unreachable remote quickly instead of hanging', async () => {
    const local = memoryLocal()
    const remote = drive('file:///does/not/exist', 'A')
    const engine = new SyncEngine({ local, remote, deviceId: 'A', deviceName: 'A' })
    editPage(local, PAGE, (p) => addTextBox(p, 'x'))
    const started = Date.now()
    const report = await engine.syncOnce()
    expect(['offline', 'error']).toContain(report.status)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it('passes a token only through the child environment', async () => {
    const url = bareRepo()
    const token = 'ghp_secretsecretsecret'
    const d = drive(url, 'A', async () => tokenEnv(token))
    await d.upload('devices/A.json', new TextEncoder().encode('{}'))
    await d.flush()
    const config = readFileSync(join(d.dir, '.git', 'config'), 'utf8')
    expect(config).not.toContain(token)
    expect(config).not.toContain('extraheader')
    expect(existsSync(join(d.dir, '.git'))).toBe(true)
    const env = tokenEnv(token)
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(' ').pop()!, 'base64').toString()).toBe(`x-access-token:${token}`)
  })
})
