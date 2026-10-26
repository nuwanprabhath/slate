import type { KeyHandle } from '@slate/native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeGitRunner } from '@slate/sync'
import { createVault, parseHeader, type VaultHeader } from './header'
import { claimRemote, GitVaultRemote, OneDriveVaultRemote, RemoteChangedElsewhere, updateRemoteHeader } from './remoteVault'
import { secretBytes } from '../../shared/secret'

// Each test spawns tens of git processes; 5 s is too tight on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
let dir: string
let bare: string

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

function remote(name: string): GitVaultRemote {
  return new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
}

/** A plaintext Slate history: two commits under docs/. */
function plaintextHistory(): void {
  const work = join(dir, 'work')
  git(dir, 'clone', '-q', bare, work)
  git(work, 'checkout', '-q', '-b', 'main')
  mkdirSync(join(work, 'docs/page_x'), { recursive: true })
  writeFileSync(join(work, 'docs/page_x/1.chunk'), 'PLAINTEXT-MARKER')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'one')
  writeFileSync(join(work, 'README.md'), 'readme')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'two')
  git(work, 'push', '-q', 'origin', 'main')
}

async function vault(): Promise<{ header: VaultHeader; mk: KeyHandle }> {
  const { header, mk } = await createVault({ password: secretBytes('correct horse battery'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
  return { header, mk }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-remote-vault-'))
  bare = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('GitVaultRemote', () => {
  it('fetches only the sync branch, without tags', async () => {
    plaintextHistory()
    git(bare, 'branch', 'old-notes', 'main')
    git(bare, 'tag', 'v1', 'main')
    const r = remote('r')
    await r.read()
    const refs = git(join(dir, 'r'), 'for-each-ref', '--format=%(refname)')
    expect(refs).toContain('refs/remotes/origin/main')
    expect(refs).not.toMatch(/old-notes|v1/)
  })

  it('reads an empty remote as no vault and no files', async () => {
    expect(await remote('a').read()).toEqual({ header: null, version: null, otherFiles: [] })
  })

  it('claim leaves the branch with only the README and e2ee files and no older commit', async () => {
    plaintextHistory()
    const r = remote('a')
    const before = await r.read()
    expect(before.otherFiles).toEqual(['docs/page_x/1.chunk'])
    const { header } = await vault()
    expect(await r.claim(header, before.version)).toBe(true)
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort()).toEqual(['README.md', 'e2ee/README.md', 'e2ee/vault.json'])
    expect(git(bare, 'rev-list', '--count', 'main').trim()).toBe('1')
    const after = await r.read()
    expect(parseHeader(after.header, weak)).toEqual(header)
    expect(after.otherFiles).toEqual([])
  })

  it('a claim on a remote that moved since it was read loses the lease', async () => {
    plaintextHistory()
    const r = remote('a')
    const seen = await r.read()
    const work = join(dir, 'work')
    writeFileSync(join(work, 'late.txt'), 'x')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'late')
    git(work, 'push', '-q', 'origin', 'main')
    expect(await r.claim((await vault()).header, seen.version)).toBe(false)
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toContain('late.txt')
  })

  it('header writes are compare-and-swap: the second writer on the same version is refused', async () => {
    const { header, mk } = await vault()
    const a = remote('a')
    const b = remote('b')
    expect(await a.claim(header, null)).toBe(true)
    const va = await a.read()
    const vb = await b.read()
    const { changePassword, newRecoveryKey, proveSecret } = await import('./header')
    const proof = await proveSecret(header, { password: secretBytes('correct horse battery') }, weak)
    const h2 = await changePassword(header, mk, proof, secretBytes('another long password'), weak)
    expect(await a.writeHeader(h2, va.version)).toBe(true)
    expect(await b.writeHeader(newRecoveryKey(header, mk, proof).header, vb.version)).toBe(false)
    expect(parseHeader((await b.read()).header, weak).revision).toBe(2)
  })
})

describe('claimRemote', () => {
  it('joins when the lease fails because another device claimed first', async () => {
    plaintextHistory()
    const a = remote('a')
    const b = remote('b')
    const theirs = await vault()
    const ours = await vault()
    let raced = false
    const racing = {
      read: () => a.read(),
      writeHeader: a.writeHeader.bind(a),
      claim: async (h: VaultHeader, v: string | null) => {
        if (!raced) {
          raced = true
          expect(await b.claim(theirs.header, (await b.read()).version)).toBe(true)
        }
        return a.claim(h, v)
      },
    }
    const result = await claimRemote(racing, ours.header)
    expect(result.kind).toBe('join')
    expect(result.kind === 'join' && parseHeader(result.header, weak).vaultId).toBe(theirs.header.vaultId)
  })

  it('joins without claiming when the remote already has a vault', async () => {
    const theirs = await vault()
    await remote('b').claim(theirs.header, null)
    const result = await claimRemote(remote('a'), (await vault()).header)
    expect(result.kind).toBe('join')
  })

  it('retries a lost lease when the remote still has no vault', async () => {
    plaintextHistory()
    const a = remote('a')
    let pushes = 0
    const flaky = {
      read: () => a.read(),
      writeHeader: a.writeHeader.bind(a),
      claim: async (h: VaultHeader, v: string | null) => (++pushes === 1 ? false : a.claim(h, v)),
    }
    const ours = await vault()
    expect(await claimRemote(flaky, ours.header)).toEqual({ kind: 'claimed' })
    expect(pushes).toBe(2)
  })
})

describe('updateRemoteHeader', () => {
  it('review C9 M5: a concurrent writer’s header is never written over; the change is refused and the writer wins', async () => {
    const { header, mk } = await vault()
    const a = remote('a')
    const b = remote('b')
    await a.claim(header, null)
    const { newRecoveryKey, proveSecret } = await import('./header')
    const proof = await proveSecret(header, { password: secretBytes('correct horse battery') }, weak)
    // B writes revision 2 between A's read and A's write.
    let interfered = false
    const racing = {
      read: () => a.read(),
      claim: a.claim.bind(a),
      writeHeader: async (h: VaultHeader, v: string | null) => {
        if (!interfered) {
          interfered = true
          const snap = await b.read()
          expect(await b.writeHeader(newRecoveryKey(header, mk, proof).header, snap.version)).toBe(true)
        }
        return a.writeHeader(h, v)
      },
    }
    await expect(updateRemoteHeader(racing, header, mk, (base) => newRecoveryKey(base, mk, proof).header, header, weak)).rejects.toThrow(RemoteChangedElsewhere)
    expect(parseHeader((await a.read()).header, weak).revision).toBe(2)
  })
  it('review C5 L5: never writes over a remote header it cannot parse (a newer Slate\'s, or a damaged one)', async () => {
    const { header, mk } = await vault()
    for (const theirs of [{ format: 'slate-vault', version: 3, vaultId: header.vaultId }, { format: 'slate-vault', version: 2, extra: true }, 'not a header']) {
      const writeHeader = vi.fn(async () => true)
      const remote = { read: async () => ({ header: theirs, version: 'v1', otherFiles: [] }), claim: async () => false, writeHeader }
      await expect(updateRemoteHeader(remote, header, mk, (base) => base, header, weak)).rejects.toThrow(/made by a newer Slate|damaged/)
      expect(writeHeader).not.toHaveBeenCalled()
    }
  })
})

describe('OneDriveVaultRemote', () => {
  function fakeGraph(files: Map<string, { body: string; eTag: string }>) {
    let n = 0
    const calls: string[] = []
    const err = (status: number) => Object.assign(new Error(String(status)), { status })
    return {
      calls,
      http: {
        async json<T>(url: string): Promise<T> {
          calls.push(`GET ${url}`)
          if (url.endsWith('/children')) return { value: [...new Set([...files.keys()].map((p) => p.split('/')[0]))].map((name) => ({ name })) } as T
          const path = decodeURIComponent(url.split(':/')[1]!)
          const f = files.get(path)
          if (!f) throw err(404)
          return { eTag: f.eTag } as T
        },
        async bytes(url: string) {
          const path = decodeURIComponent(url.split(':/')[1]!.replace(/:\/content$/, ''))
          const f = files.get(path)
          if (!f) throw err(404)
          return { bytes: new TextEncoder().encode(f.body), mime: 'application/json' }
        },
        async send(url: string, init: RequestInit): Promise<Response> {
          calls.push(`${init.method} ${url}`)
          const path = decodeURIComponent(url.split(':/')[1]!.replace(/:\/content.*$/, ''))
          if (init.method === 'DELETE') {
            for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
            return new Response(null, { status: 204 })
          }
          const existing = files.get(path)
          const ifMatch = new Headers(init.headers).get('If-Match')
          if (url.includes('conflictBehavior=fail') && existing) throw err(409)
          if (ifMatch && existing?.eTag !== ifMatch) throw err(412)
          files.set(path, { body: String(init.body), eTag: `e${++n}` })
          return new Response('{}', { status: 201 })
        },
      },
    }
  }

  it('claims with a conditional create, then deletes the plaintext folders', async () => {
    const files = new Map([['docs/page_x/a/1.chunk', { body: 'x', eTag: 'e0' }], ['devices/d.json', { body: '{}', eTag: 'e0' }]])
    const { http, calls } = fakeGraph(files)
    const r = new OneDriveVaultRemote(http)
    const snap = await r.read()
    expect(snap.header).toBeNull()
    expect(snap.otherFiles.sort()).toEqual(['devices', 'docs'])
    const { header } = await vault()
    expect(await r.claim(header, snap.version)).toBe(true)
    expect([...files.keys()].sort()).toEqual(['e2ee/README.md', 'e2ee/vault.json'])
    expect(calls.some((c) => c.includes('conflictBehavior=fail'))).toBe(true)
  })

  it('a second claim conflicts, and header writes need the eTag read', async () => {
    const files = new Map<string, { body: string; eTag: string }>()
    const { http } = fakeGraph(files)
    const r = new OneDriveVaultRemote(http)
    const { header, mk } = await vault()
    expect(await r.claim(header, null)).toBe(true)
    expect(await r.claim(header, null)).toBe(false)
    const snap = await r.read()
    const { newRecoveryKey } = await import('./header')
    const h2 = newRecoveryKey(header, mk, await (await import('./header')).proveSecret(header, { password: secretBytes('correct horse battery') }, weak)).header
    expect(await r.writeHeader(h2, 'stale')).toBe(false)
    expect(await r.writeHeader(h2, snap.version)).toBe(true)
  })
})
