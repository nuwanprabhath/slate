import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript with no declaration file; the calls below pin its shape
import { confirmedFor, guardDiffHash, MERGE_MESSAGE, mergeSignatureOk, mergeTrailer, pushConfirmed, unacceptedCommits } from '../../scripts/agents/review-gate.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { agentRefusal, confirmGuardChanges, parseRange } from '../../scripts/agents/merge-wp.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { initKey, keychainAddCommand, loadSigningKey } from '../../scripts/agents/unlock.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { mainPushes } from '../../scripts/agents/check-push.mjs'
import { read } from './repo'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const lead = generateKeyPairSync('ed25519')
const PUB = lead.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PEM = lead.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const other = generateKeyPairSync('ed25519').privateKey
const signer = (key: unknown) => (message: string) => Promise.resolve(sign(null, Buffer.from(message, 'utf8'), key as string).toString('base64'))
type Confirmed = { ok: boolean; line?: string; why?: string }

describe('merge-wp: who may run it (red team G2-12)', () => {
  const at = { cwd: '/repo', here: '/repo', mainCheckout: '/repo' }
  it('refuses inside an agent session, whatever the script location says', () => {
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CLAUDE_PROJECT_DIR: '/repo' }, { AI_AGENT: 'claude' }, { CODEX_SANDBOX: '1' }]) {
      expect(agentRefusal({ ...at, env }), JSON.stringify(env)).toMatch(/agent session/)
    }
  })
  it('refuses unless the shell itself is in the main checkout', () => {
    expect(agentRefusal({ ...at, cwd: '/repo/.claude/worktrees/agent-7', env: {} })).toMatch(/main checkout/)
    expect(agentRefusal({ ...at, here: '/repo/.claude/worktrees/agent-7', env: {} })).toMatch(/main checkout/)
    expect(agentRefusal({ ...at, env: { HOME: '/home/me', PATH: '/bin' } })).toBeNull()
  })
})

describe('merge-wp: the person confirms guard-file changes out of band (red team G2-13)', () => {
  const diff = 'diff --git a/eslint.config.mjs b/eslint.config.mjs\n-  a\n+  b\n'
  it('signs `<subject> <head> <guard diff hash>` with the lead key from the Keychain and verifies it', async () => {
    const r = (await confirmGuardChanges({ subject: 'phase11/g2', head: HEAD, diff, sign: signer(PEM), publicKey: PUB })) as Confirmed
    expect(r.ok).toBe(true)
    expect(confirmedFor(r.line, { subject: 'phase11/g2', head: HEAD, hash: guardDiffHash(diff) }, PUB)).toBe(true)
  })
  it('binds the confirmation to the subject, the head and the exact guard diff', async () => {
    const { line } = (await confirmGuardChanges({ subject: 'phase11/g2', head: HEAD, diff, sign: signer(PEM), publicKey: PUB })) as Confirmed
    expect(confirmedFor(line, { subject: 'phase11/g3', head: HEAD, hash: guardDiffHash(diff) }, PUB)).toBe(false)
    expect(confirmedFor(line, { subject: 'phase11/g2', head: 'f'.repeat(40), hash: guardDiffHash(diff) }, PUB)).toBe(false)
    expect(confirmedFor(line, { subject: 'phase11/g2', head: HEAD, hash: guardDiffHash(`${diff}+  c\n`) }, PUB)).toBe(false)
    expect(confirmedFor(line, { subject: 'phase11/g2', head: HEAD, hash: guardDiffHash(diff) }, null)).toBe(false)
  })
  it('another key, a declined dialog or no terminal confirms nothing, and says which', async () => {
    const forged = (await confirmGuardChanges({ subject: 'x', head: HEAD, diff, sign: signer(other), publicKey: PUB })) as Confirmed
    expect(forged).toMatchObject({ ok: false, why: expect.stringMatching(/does not verify/) })
    const noTty = (await confirmGuardChanges({ subject: 'x', head: HEAD, diff, sign: () => Promise.reject(Object.assign(new Error('ENXIO: no such device or address, open /dev/tty'), { code: 'ENXIO' })), publicKey: PUB })) as Confirmed
    expect(noTty).toMatchObject({ ok: false, why: expect.stringMatching(/no terminal/) })
    const declined = (await confirmGuardChanges({ subject: 'x', head: HEAD, diff, sign: () => Promise.reject(new Error('User canceled the operation.')), publicKey: PUB })) as Confirmed
    expect(declined).toMatchObject({ ok: false, why: expect.stringMatching(/not confirmed/) })
  })
  it('reads a batch range', () => {
    expect(parseRange('abc..def')).toEqual({ from: 'abc', to: 'def' })
    expect(parseRange('origin/main..main')).toEqual({ from: 'origin/main', to: 'main' })
    expect(parseRange('main')).toBeNull()
    expect(parseRange('a...b')).toBeNull()
  })
})

describe('pre-push: main leaves the machine only with its guard-file changes confirmed (batch mode)', () => {
  // Commits R (on the remote) → M → L (local). Guard files change R→M and M→L; X has R's guard files.
  const diffs: Record<string, string> = { 'R..L': 'D-RL', 'R..M': 'D-RM', 'M..L': 'D-ML', 'X..L': 'D-RL', 'R..X': '' }
  const guardDiff = (from: string, to: string) => (from === to ? '' : diffs[`${from}..${to}`] ?? `D-${from}${to}`)
  const confirm = async (from: string, to: string) =>
    ((await confirmGuardChanges({ subject: `${from}..${to}`, head: to, diff: guardDiff(from, to), sign: signer(PEM), publicKey: PUB })) as Confirmed).line
  const check = (confirmations: string, remote = 'R', local = 'L') => pushConfirmed({ guardDiff, confirmations, publicKey: PUB, remote, local })

  it('refuses a push whose guard-file changes nobody confirmed', () => {
    expect(check('')).toBe(false)
  })
  it('accepts one confirmation covering everything since the remote', async () => {
    expect(check(`${await confirm('R', 'L')}\n`)).toBe(true)
    expect(check(`${await confirm('X', 'L')}\n`)).toBe(true)
  })
  it('refuses when guard files changed after the last confirmation, or the line is forged', async () => {
    expect(check(`${await confirm('R', 'M')}\n`)).toBe(false)
    const line = (await confirm('R', 'L')) as string
    expect(check(line.replace(/\S+$/, Buffer.alloc(64, 1).toString('base64')))).toBe(false)
    expect(pushConfirmed({ guardDiff, confirmations: line, publicKey: null, remote: 'R', local: 'L' })).toBe(false)
  })
  it('needs nothing when no guard file changed', () => {
    expect(check('', 'R', 'X')).toBe(true)
  })
  it('the pre-push hook checks every push to main, and refuses a new main it cannot compare', () => {
    const zero = '0'.repeat(40)
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    expect(mainPushes(`refs/heads/main ${b} refs/heads/main ${a}\nrefs/heads/x ${b} refs/heads/x ${a}\n`)).toEqual([{ remote: a, local: b }])
    expect(mainPushes(`refs/heads/x ${b} refs/heads/main ${a}\n`)).toEqual([{ remote: a, local: b }])
    expect(mainPushes(`(delete) ${zero} refs/heads/main ${a}\n`)).toEqual([])
    expect(mainPushes(`refs/heads/main ${b} refs/heads/main ${zero}\n`)).toEqual([{ remote: null, local: b }])
  })

  it('the hook runs the main checkout\'s check-push, never the pushing branch\'s copy (red team final F-4)', () => {
    const hook = read('.githooks/pre-push')
    expect(hook).toMatch(/git rev-parse --path-format=absolute --git-common-dir/)
    expect(hook).toMatch(/node "\$main\/scripts\/agents\/check-push\.mjs" \|\| exit 1/)
    expect(hook).not.toMatch(/^node scripts\//m)
  })
})

describe('pre-push: every commit new on main is a signed merge-wp merge, or covered by the maintainer (red team final F-3)', () => {
  const P1 = 'a'.repeat(40)
  const P2 = 'b'.repeat(40)
  const TREE = 'c'.repeat(40)
  const merge = async (tree = TREE) => ({ sha: 'd'.repeat(40), parents: [P1, P2], tree, body: `Merge phase11/x\n\n${mergeTrailer((await signer(PEM)(MERGE_MESSAGE(P1, P2, TREE))) as string)}\n` })

  it('a merge-wp merge carries a lead-signed trailer over its parents and tree', async () => {
    expect(mergeSignatureOk(await merge(), PUB)).toBe(true)
    // Amended to another tree, re-parented, or signed by another key: not merge-wp's.
    expect(mergeSignatureOk(await merge('e'.repeat(40)), PUB)).toBe(false)
    expect(mergeSignatureOk({ ...(await merge()), parents: [P2, P1] }, PUB)).toBe(false)
    const forged = { sha: 'd'.repeat(40), parents: [P1, P2], tree: TREE, body: mergeTrailer((await signer(other)(MERGE_MESSAGE(P1, P2, TREE))) as string) }
    expect(mergeSignatureOk(forged, PUB)).toBe(false)
    expect(mergeSignatureOk(await merge(), null)).toBe(false)
  })

  it('refuses a plain `git merge` or a direct commit on main unless a maintainer confirmation covers it', async () => {
    const plain = { sha: '1'.repeat(40), parents: [P1, P2], tree: TREE, body: 'Merge branch phase11/x' }
    const direct = { sha: '2'.repeat(40), parents: [P1], tree: TREE, body: 'fix: x' }
    const commits = [await merge(), plain, direct]
    expect(unacceptedCommits({ commits, covered: () => false, publicKey: PUB }).map((c: { sha: string }) => c.sha)).toEqual([plain.sha, direct.sha])
    expect(unacceptedCommits({ commits, covered: (sha: string) => sha === plain.sha || sha === direct.sha, publicKey: PUB })).toEqual([])
  })
})

describe('unlock.mjs: the lead key never reaches an agent (red team G2-10, G2-11)', () => {
  const b64 = Buffer.from(PEM).toString('base64')
  it('signs only with the Keychain on macOS, never a silent file fallback', async () => {
    await expect(loadSigningKey({ platform: 'darwin', useFile: false, isTTY: true, keychainRead: () => { throw new Error('declined') }, readFile: () => PEM })).rejects.toThrow(/Keychain/)
    await expect(loadSigningKey({ platform: 'darwin', useFile: true, isTTY: true, keychainRead: () => b64, readFile: () => PEM })).rejects.toThrow(/macOS/)
    const key = await loadSigningKey({ platform: 'darwin', useFile: false, isTTY: false, keychainRead: () => b64, readFile: () => null })
    expect(sign(null, Buffer.from('x'), key).length).toBe(64)
  })
  it('on Linux, needs --file, a terminal and the passphrase', async () => {
    const encrypted = lead.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct horse' }).toString()
    const deps = { platform: 'linux', useFile: true, isTTY: true, keychainRead: () => '', readFile: () => encrypted, askPassphrase: () => Promise.resolve('correct horse') }
    await expect(loadSigningKey({ ...deps, useFile: false })).rejects.toThrow(/--file/)
    await expect(loadSigningKey({ ...deps, isTTY: false })).rejects.toThrow(/terminal/)
    await expect(loadSigningKey({ ...deps, askPassphrase: () => Promise.resolve('wrong') })).rejects.toThrow()
    expect(sign(null, Buffer.from('x'), await loadSigningKey(deps)).length).toBe(64)
  })
  it('--init refuses to replace a key; --rotate replaces it and prints the new public key', async () => {
    const stored: string[] = []
    const deps = { platform: 'darwin', rotate: false, useFile: false, isTTY: true, exists: () => true, storeKeychain: (input: string) => void stored.push(input), writeFile: () => {}, askPassphrase: () => Promise.resolve('') }
    await expect(initKey(deps)).rejects.toThrow(/--rotate/)
    expect(stored).toEqual([])
    const pub = (await initKey({ ...deps, rotate: true })) as string
    expect(pub).toMatch(/BEGIN PUBLIC KEY/)
    expect(stored).toHaveLength(1)
    await expect(initKey({ ...deps, platform: 'linux', useFile: true, isTTY: false, exists: () => false })).rejects.toThrow(/terminal/)
  })
  it('hands the private key to `security` on stdin, never on its command line', () => {
    const { args, input } = keychainAddCommand(b64, { rotate: false }) as { args: string[]; input: string }
    expect(args.join(' ')).not.toContain(b64)
    expect(args).toEqual(['-i'])
    expect(input).toContain('add-generic-password')
    expect(input).toContain('-T ""')
    expect(input).toContain(b64)
    expect(input).not.toContain(' -U ')
    expect((keychainAddCommand(b64, { rotate: true }) as { input: string }).input).toContain(' -U ')
  })
})
