import { describe, expect, it } from 'vitest'
import { isAllowedBranch, isAllowedRemote, isAllowedRepoName } from './gitRemote'

describe('isAllowedRemote (C3)', () => {
  const accepted: [string, string][] = [
    ['https', 'https://github.com/owner/repo.git'],
    ['ssh', 'ssh://git@github.com/owner/repo.git'],
    ['git+ssh', 'git+ssh://git@github.com/owner/repo.git'],
    ['scp-style', 'git@github.com:owner/repo.git'],
    ['scp-style without a user', 'github.com:owner/repo.git'],
  ]
  it.each(accepted)('accepts a %s remote', (_name, url) => {
    expect(isAllowedRemote(url, { allowLocal: false })).toBe(true)
  })

  const refused: [string, string][] = [
    ['an argument, not a URL', '--upload-pack=x'],
    ['a short option', '-oProxyCommand=x'],
    ['a remote helper', 'ext::sh -c id'],
    ['a helper with no space', 'ext::sh'],
    ['a transport git refuses', 'git://github.com/owner/repo.git'],
    ['a NUL', 'https://github.com/owner/repo\u0000.git'],
    ['a newline', 'https://github.com/owner/repo\n--upload-pack=x'],
    ['an escape', 'https://github.com/owner/\u001brepo'],
    ['a space', 'https://github.com/owner/re po'],
    ['no host', 'https:///owner/repo'],
    ['empty', ''],
    ['a non-string', 42 as unknown as string],
    ['something far too long', `https://github.com/${'a'.repeat(5000)}`],
  ]
  it.each(refused)('refuses %s', (_name, url) => {
    expect(isAllowedRemote(url, { allowLocal: false })).toBe(false)
    expect(isAllowedRemote(url, { allowLocal: true })).toBe(false)
  })

  const local = ['file:///tmp/slate-remote.git', '/tmp/slate-remote.git', './remote.git', '../remote.git']
  it.each(local)('accepts %s only with allowLocal', (url) => {
    expect(isAllowedRemote(url, { allowLocal: true })).toBe(true)
    expect(isAllowedRemote(url, { allowLocal: false })).toBe(false)
  })
})

describe('isAllowedBranch (C3)', () => {
  it.each(['main', 'feature/x', 'release-1.2'])('accepts %s', (b) => {
    expect(isAllowedBranch(b)).toBe(true)
  })
  it.each([['--force'], ['-b'], [''], ['a..b'], ['a b'], ['a\nb'], ['x\u0000'], ['/leading'], ['trailing/'], ['a//b'], ['x.lock'], ['a~1'], ['a^'], ['a:b'], ['a?'], ['a*'], ['a[1]'], ['a\\b'], ['a@{0}'], ['a.']])(
    'refuses %j',
    (b) => {
      expect(isAllowedBranch(b)).toBe(false)
    },
  )
})

describe('isAllowedRepoName (C3)', () => {
  it.each(['slate-notes', 'notes.git', 'a_b'])('accepts %s', (n) => {
    expect(isAllowedRepoName(n)).toBe(true)
  })
  it.each([['-notes'], [''], ['a/b'], ['a b'], ['a\u0000']])('refuses %j', (n) => {
    expect(isAllowedRepoName(n)).toBe(false)
  })
})
