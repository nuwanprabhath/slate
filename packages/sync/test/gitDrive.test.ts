import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine } from '../src/engine'
import { GitDrive } from '../src/gitDrive'
import { nodeGitRunner, tokenEnv } from '../src/gitRunner'
import { chunkPath } from '../src/paths'
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
    // B's later syncs carry one chunk: its device record is no longer rewritten each time.
    expect(log(url)).toMatch(/slate: B \(\d+ files?\)/)
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

  it('makes no commit when only the encrypted device record changed, and uses a fixed message', async () => {
    const url = bareRepo()
    const d = new GitDrive({ run, dir: join(temp(), 'repo'), remoteUrl: url, branch: 'main', authEnv: async () => ({}), author: { name: 'Slate', email: 'slate@invalid' }, commitMessage: 'slate: sync' })
    await d.upload('e2ee/v/abc.c', new Uint8Array([1]))
    await d.flush()
    const commits = log(url).trim().split('\n')
    expect(commits[0]).toBe('slate: sync')
    await d.upload('e2ee/v/abc.c', new Uint8Array([2]))
    await d.flush()
    expect(log(url).trim().split('\n')).toHaveLength(commits.length)
  })

  it('reports file sizes in delta, in full and incremental listings', async () => {
    const url = bareRepo()
    const d = drive(url, 'A')
    await d.upload('blobs/x.bin', new Uint8Array(1234))
    await d.flush()
    const full = await d.delta(null)
    expect(full.items.find((i) => i.path === 'blobs/x.bin')?.size).toBe(1234)
    await d.upload('blobs/y.bin', new Uint8Array(7))
    await d.flush()
    expect((await d.delta(full.cursor)).items).toMatchObject([{ path: 'blobs/y.bin', size: 7 }])
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

describe('GitDrive against a hostile clone', { timeout: 30_000 }, () => {
  async function hardened() {
    const url = bareRepo()
    const dir = join(temp(), 'repo')
    const d = new GitDrive({ run, dir, remoteUrl: url, branch: 'main', authEnv: async () => ({}), author: { name: 'A', email: 'a@test.local' } })
    await d.delta(null)
    const outside = temp()
    writeFileSync(join(outside, 'secret'), 'outside')
    return { url, dir, d, outside }
  }

  it('sets core.symlinks=false in the clone', async () => {
    const { dir } = await hardened()
    expect(execFileSync('git', ['-C', dir, 'config', 'core.symlinks']).toString().trim()).toBe('false')
  })

  it('refuses to read, write or remove through a symlinked file', async () => {
    const { dir, d, outside } = await hardened()
    mkdirSync(join(dir, 'pages'))
    symlinkSync(join(outside, 'secret'), join(dir, 'pages', 'x'))
    await expect(d.download('pages/x')).rejects.toThrow(/not a regular file/)
    await expect(d.upload('pages/x', new Uint8Array([1]))).rejects.toThrow(/not a regular file/)
    await expect(d.remove('pages/x')).rejects.toThrow(/not a regular file/)
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('outside')
  })

  it('refuses paths through a symlinked folder or outside the clone', async () => {
    const { dir, d, outside } = await hardened()
    symlinkSync(outside, join(dir, 'evil'))
    await expect(d.upload('evil/new', new Uint8Array([1]))).rejects.toThrow(/outside the sync folder/)
    await expect(d.download('evil/secret')).rejects.toThrow(/outside the sync folder/)
    expect(existsSync(join(outside, 'new'))).toBe(false)
    await expect(d.upload('../escape', new Uint8Array([1]))).rejects.toThrow()
    await expect(d.upload(join(outside, 'abs'), new Uint8Array([1]))).rejects.toThrow()
    expect(existsSync(join(outside, 'abs'))).toBe(false)
  })

  it('checks a committed symlink out as a plain file, never following it', async () => {
    const { url, dir, d, outside } = await hardened()
    const attacker = temp()
    execFileSync('git', ['clone', '-q', url.slice('file://'.length), attacker])
    symlinkSync(join(outside, 'secret'), join(attacker, 'link'))
    execFileSync('git', ['-C', attacker, 'add', 'link'])
    execFileSync('git', ['-C', attacker, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'link'])
    execFileSync('git', ['-C', attacker, 'push', '-q', 'origin', 'HEAD:main'])
    await d.flush()
    await d.delta(null)
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(false)
    expect(Buffer.from(await d.download('link')).toString()).toBe(join(outside, 'secret'))
  })
})

const bareGit = (url: string, args: string[], input?: string) =>
  execFileSync('git', ['--git-dir', url.slice('file://'.length), ...args], input === undefined ? {} : { input }).toString()

/** Commits a root tree of `entries` (`<mode> <type> <sha>\t<name>`) straight into the bare repo. */
function pushTree(url: string, entries: string[], opts: { parent?: boolean; branch?: string } = {}): string {
  const tree = bareGit(url, ['mktree', '-z'], entries.map((e) => `${e}\0`).join('')).trim()
  const branch = opts.branch ?? 'main'
  const parent = opts.parent ? ['-p', bareGit(url, ['rev-parse', branch]).trim()] : []
  const commit = bareGit(url, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree, ...parent, '-m', 'other']).trim()
  bareGit(url, ['update-ref', `refs/heads/${branch}`, commit])
  return commit
}

const blob = (url: string, content: string) => bareGit(url, ['hash-object', '-w', '--stdin'], content).trim()

/** A root-level tree entry holding `leaf` (`<mode> <type> <sha>`) at `path`. */
function nested(url: string, path: string, leaf: string): string {
  const parts = path.split('/')
  let entry = `${leaf}\t${parts.pop()!}`
  while (parts.length > 0) {
    const tree = bareGit(url, ['mktree', '-z'], `${entry}\0`).trim()
    entry = `040000 tree ${tree}\t${parts.pop()!}`
  }
  return entry
}

describe('GitDrive against a hostile or replaced remote', { timeout: 30_000 }, () => {
  it('refuses to replay plaintext history onto an unrelated encrypted branch', async () => {
    const url = bareRepo()
    const a = device(url, 'A')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'secret plaintext'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    // Another device encrypts: an orphan commit with no README.md, so nothing conflicts by accident.
    const orphan = pushTree(url, [nested(url, 'e2ee/vault.json', `100644 blob ${blob(url, '{}')}`)])
    editPage(a.local, PAGE, (p) => addTextBox(p, 'more plaintext', { x: 0, y: 300 }))
    const report = await a.engine.syncOnce()
    expect(report.status).toBe('error')
    expect(report.message).toMatch(/encrypted/i)
    expect(bareGit(url, ['rev-parse', 'main']).trim()).toBe(orphan)
    await expect(a.remote.delta(null)).rejects.toMatchObject({ unrelatedHistory: true, encryptedRemote: true })
  })

  it('refuses an unrelated plaintext branch too', async () => {
    const url = bareRepo()
    const d = drive(url, 'A')
    await d.delta(null)
    pushTree(url, [`100644 blob ${blob(url, 'x')}\tother.txt`])
    await d.upload('docs/x', new Uint8Array([1]))
    await expect(d.flush()).rejects.toMatchObject({ unrelatedHistory: true, encryptedRemote: false })
  })

  it('lists only regular files: a gitlink in docs/ does not stop sync', async () => {
    const url = bareRepo()
    const a = device(url, 'A')
    editPage(a.local, PAGE, (p) => addTextBox(p, 'x'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    const head = bareGit(url, ['rev-parse', 'main']).trim()
    const root = bareGit(url, ['ls-tree', '-z', head]).split('\0').filter((e) => e !== '')
    const path = chunkPath(PAGE, 'Z', 1)
    const [, key] = path.split('/')
    const docs = bareGit(url, ['ls-tree', '-z', `${head}:docs/${key!}`]).split('\0').filter((e) => e !== '')
    const link = nested(url, path.split('/').slice(2).join('/'), `160000 commit ${head}`)
    const page = bareGit(url, ['mktree', '-z'], [...docs, link].map((e) => `${e}\0`).join('')).trim()
    const others = bareGit(url, ['ls-tree', '-z', `${head}:docs`]).split('\0').filter((e) => e !== '' && !e.endsWith(`\t${key!}`))
    const docsTree = bareGit(url, ['mktree', '-z'], [...others, `040000 tree ${page}\t${key!}`].map((e) => `${e}\0`).join('')).trim()
    pushTree(url, [...root.filter((e) => !e.endsWith('\tdocs')), `040000 tree ${docsTree}\tdocs`], { parent: true })
    const b = device(url, 'B')
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect((await b.remote.delta(null)).items.map((i) => i.path)).not.toContain(path)
    await expect(b.remote.download(path)).rejects.toMatchObject({ unverifiable: true })
  })

  it('fetches only the sync branch, without tags', async () => {
    const url = bareRepo()
    const d = drive(url, 'A')
    await d.delta(null)
    pushTree(url, [`100644 blob ${blob(url, 'old plaintext')}\tnotes.txt`], { branch: 'old' })
    bareGit(url, ['tag', 'v1', 'old'])
    await d.delta(null)
    const refs = execFileSync('git', ['-C', d.dir, 'for-each-ref', '--format=%(refname)']).toString()
    expect(refs).toContain('refs/remotes/origin/main')
    expect(refs).not.toMatch(/old|v1/)
    // A first clone of a remote that already has other branches fetches only ours too.
    const e = drive(url, 'B')
    await e.delta(null)
    expect(execFileSync('git', ['-C', e.dir, 'for-each-ref', '--format=%(refname)']).toString()).not.toMatch(/old|v1/)
  })
})
