import { describe, expect, it } from 'vitest'
import {
  isBool,
  isBytes,
  isCount,
  isDocId,
  isDocPrefix,
  isGitSettings,
  isId,
  isMenuPath,
  isObject,
  isOneOf,
  isSyncConfig,
  isText,
  isTextList,
  MalformedRequest,
  MAX_UPDATE_BYTES,
  optional,
  refuse,
  RESOLVE_CHOICES,
} from './ipcValidators'

const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('refuse', () => {
  it('throws the channel\'s one refusal text', () => {
    expect(() => refuse('docs:append')).toThrow(new MalformedRequest('docs:append'))
    expect(() => refuse('docs:append')).toThrow('Refused a malformed docs:append request')
  })
})

describe('isDocId', () => {
  it('accepts a kind and an id as newId makes it', () => {
    expect(isDocId(`page:${uuid}`)).toBe(true)
    expect(isDocId(`notebook:${uuid}`)).toBe(true)
  })

  it('refuses another kind, a missing or malformed id, and anything that is not a string', () => {
    for (const bad of [
      'test:1',
      `section:${uuid}`,
      `page:${uuid.toUpperCase()}`,
      'page:',
      `:${uuid}`,
      uuid,
      `page:${uuid}x`,
      `page:${uuid}\n`,
      `page:${uuid}; DROP TABLE docs`,
      null,
      undefined,
      5,
      {},
      [`page:${uuid}`],
    ]) {
      expect(isDocId(bad), JSON.stringify(bad) ?? 'undefined').toBe(false)
    }
  })
})

describe('the small checks', () => {
  it('isId takes only a uuid', () => {
    expect(isId(uuid)).toBe(true)
    expect(isId('')).toBe(false)
    expect(isId(`${uuid} `)).toBe(false)
  })

  it('isDocPrefix takes one kind or everything', () => {
    expect([isDocPrefix(''), isDocPrefix('page:'), isDocPrefix('notebook:')]).toEqual([true, true, true])
    expect([isDocPrefix('page'), isDocPrefix(`page:${uuid}`), isDocPrefix(null)]).toEqual([false, false, false])
  })

  it('isText caps the length', () => {
    expect(isText('a'.repeat(10_000))).toBe(true)
    expect(isText('a'.repeat(10_001))).toBe(false)
    expect(isText('ab', 1)).toBe(false)
    expect(isText(7)).toBe(false)
  })

  it('isCount takes an integer in 1..1000', () => {
    expect([isCount(1), isCount(1000)]).toEqual([true, true])
    expect([isCount(0), isCount(1001), isCount(1.5), isCount(NaN), isCount(Infinity), isCount('5'), isCount(-1)]).toEqual([false, false, false, false, false, false, false])
  })

  it('isBool takes only a boolean', () => {
    expect([isBool(true), isBool(false)]).toEqual([true, true])
    expect([isBool(0), isBool('true'), isBool(null)]).toEqual([false, false, false])
  })

  it('isBytes takes a Uint8Array inside the cap', () => {
    expect(isBytes(new Uint8Array(3), MAX_UPDATE_BYTES)).toBe(true)
    expect(isBytes(new Uint8Array(4), 3)).toBe(false)
    expect(isBytes([1, 2, 3], 16)).toBe(false)
    expect(isBytes('abc', 16)).toBe(false)
    expect(isBytes(new ArrayBuffer(3), 16)).toBe(false)
  })

  it('isObject refuses an array, null and a primitive', () => {
    expect(isObject({ a: 1 })).toBe(true)
    expect([isObject([]), isObject(null), isObject('x')]).toEqual([false, false, false])
  })

  it('isOneOf checks a literal set', () => {
    expect(isOneOf(RESOLVE_CHOICES, 'mine')).toBe(true)
    expect(isOneOf(RESOLVE_CHOICES, 'MINE')).toBe(false)
    expect(isOneOf(RESOLVE_CHOICES, 1)).toBe(false)
  })

  it('isTextList caps the list and each entry', () => {
    expect(isTextList(['a', 'b'])).toBe(true)
    expect(isTextList([])).toBe(true)
    expect(isTextList(['a', 5])).toBe(false)
    expect(isTextList(['ab'], 1)).toBe(false)
    expect(isTextList(['a', 'b'], 10, 1)).toBe(false)
    expect(isTextList('ab')).toBe(false)
  })

  it('optional takes undefined but never null or a wrong type', () => {
    expect(optional(undefined, isId)).toBe(true)
    expect(optional(uuid, isId)).toBe(true)
    expect([optional(null, isId), optional(5, isId)]).toEqual([false, false])
  })

  it('isMenuPath takes a short list of item indexes', () => {
    expect(isMenuPath([0, 3])).toBe(true)
    expect([isMenuPath([]), isMenuPath([-1]), isMenuPath([1.5]), isMenuPath(Array(17).fill(0)), isMenuPath([1000]), isMenuPath('0')]).toEqual([false, false, false, false, false, false])
  })
})

describe('isGitSettings', () => {
  const good = { remoteUrl: 'https://example.invalid/notes.git', branch: 'main', auth: 'system' }

  it('takes a remote, a branch and a known auth mode', () => {
    expect(isGitSettings(good)).toBe(true)
  })

  it('refuses a wrong type, an unknown auth mode and an oversized remote', () => {
    for (const bad of [null, 'main', [], { ...good, auth: 'sudo' }, { ...good, branch: 5 }, { ...good, remoteUrl: 'x'.repeat(4097) }, { ...good, branch: 'b'.repeat(201) }]) {
      expect(isGitSettings(bad), JSON.stringify(bad) ?? 'undefined').toBe(false)
    }
  })
})

describe('isSyncConfig', () => {
  const git = { remoteUrl: 'https://example.invalid/notes.git', branch: 'main', auth: 'token' }

  it('takes a provider with its git settings and an optional token', () => {
    expect(isSyncConfig({ provider: null })).toBe(true)
    expect(isSyncConfig({ provider: 'onedrive' })).toBe(true)
    expect(isSyncConfig({ provider: 'git', git, token: 'ghp_x' })).toBe(true)
  })

  it('refuses an unknown provider, broken git settings and an oversized token', () => {
    for (const bad of [null, 'git', { provider: 'dropbox' }, { provider: undefined }, { provider: 'git', git: { ...git, auth: 'none' } }, { provider: 'git', git, token: 't'.repeat(501) }, { provider: 'git', token: null }]) {
      expect(isSyncConfig(bad), JSON.stringify(bad) ?? 'undefined').toBe(false)
    }
  })
})
