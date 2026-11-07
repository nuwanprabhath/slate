// GitDrive against a hostile clone or remote: symlinks, unrelated branches, gitlinks, tags. Apart from
// gitDrive.test.ts so the two run side by side.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitDrive } from '../src/gitDrive'
import { chunkPath } from '../src/paths'
import { addTextBox, editPage } from './memoryLocal'
import { PAGE, bareRepo, device, drive, gitSync, removeTemps, run, temp } from './gitWorld'

afterEach(removeTemps)

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
    expect(gitSync(['-C', dir, 'config', 'core.symlinks']).toString().trim()).toBe('false')
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
    gitSync(['clone', '-q', url.slice('file://'.length), attacker])
    symlinkSync(join(outside, 'secret'), join(attacker, 'link'))
    gitSync(['-C', attacker, 'add', 'link'])
    gitSync(['-C', attacker, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'link'])
    gitSync(['-C', attacker, 'push', '-q', 'origin', 'HEAD:main'])
    await d.flush()
    await d.delta(null)
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(false)
    expect(Buffer.from(await d.download('link')).toString()).toBe(join(outside, 'secret'))
  })
})

const bareGit = (url: string, args: string[], input?: string) =>
  gitSync(['--git-dir', url.slice('file://'.length), ...args], input === undefined ? {} : { input }).toString()

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
    const refs = gitSync(['-C', d.dir, 'for-each-ref', '--format=%(refname)']).toString()
    expect(refs).toContain('refs/remotes/origin/main')
    expect(refs).not.toMatch(/old|v1/)
    // A first clone of a remote that already has other branches fetches only ours too.
    const e = drive(url, 'B')
    await e.delta(null)
    expect(gitSync(['-C', e.dir, 'for-each-ref', '--format=%(refname)']).toString()).not.toMatch(/old|v1/)
  })
})
