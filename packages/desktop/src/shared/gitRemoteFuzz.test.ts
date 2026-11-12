import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fcParams } from '../../test/fuzz'
import { isAllowedBranch, isAllowedRemote, isAllowedRepoName } from './gitRemote'

// Pieces chosen to sit on every edge of the allow-list: option dashes, helper `::`, controls, schemes, paths.
const piece = fc.constantFrom(
  '-', '--upload-pack=x', '::', ':', '/', '//', '\\', '.', '..', '@', '@{', '~', '^', '?', '*', '[', ' ', '\t', '\n', '\u0000', '\u007f', '\u00e9',
  'https://', 'ssh://', 'git+ssh://', 'file://', 'ext::', 'fd::', 'http://', 'HTTPS://', 'C:\\', 'c:/', './', '../',
  'git@', 'github.com', 'example.com', 'user:pass@', 'owner/repo.git', 'main', '.lock', 'x', '%2d', '%3a%3a'
)
const candidate = fc.oneof(fc.array(piece, { maxLength: 8 }).map((p) => p.join('')), fc.string({ maxLength: 40 }), fc.string({ unit: 'binary', maxLength: 20 }))

function hasControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

const SCHEMES = ['https://', 'ssh://', 'git+ssh://']
const SCP = /^(?:[^@/:]+@)?[^/:]+:[^:/]/
const LOCAL = /^(?:\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/

describe('git remote, branch and repo-name gates (F4b property 4)', () => {
  it('T-F4B-01: an accepted remote never starts with -, holds no :: helper or control, and is https/ssh or scp form', () => {
    fc.assert(
      fc.property(candidate, fc.boolean(), (value, allowLocal) => {
        if (!isAllowedRemote(value, { allowLocal })) return
        expect(value.startsWith('-')).toBe(false)
        expect(hasControl(value)).toBe(false)
        expect(value.includes('::') && !value.slice(0, value.indexOf('::')).includes('/')).toBe(false)
        if (allowLocal) return
        const lower = value.toLowerCase()
        expect(lower.startsWith('file:')).toBe(false)
        expect(LOCAL.test(value)).toBe(false)
        expect(SCHEMES.some((s) => lower.startsWith(s)) || SCP.test(value)).toBe(true)
      }),
      fcParams
    )
  })

  it('T-F4B-02: allowLocal false refuses every file: address and local path', () => {
    const local = fc.tuple(fc.constantFrom('file://', 'FILE://', '/', './', '../', 'C:\\', 'c:/'), fc.string({ maxLength: 30 })).map(([a, b]) => a + b)
    fc.assert(
      fc.property(local, (value) => {
        expect(isAllowedRemote(value, { allowLocal: false })).toBe(false)
      }),
      fcParams
    )
  })

  it("T-F4B-03: an accepted branch or repo name never starts with - and breaks none of git's ref rules", () => {
    fc.assert(
      fc.property(candidate, (value) => {
        if (isAllowedBranch(value)) {
          expect(value.startsWith('-')).toBe(false)
          expect(/[ ~^:?*[\\]/.test(value) || hasControl(value)).toBe(false)
          expect(value.includes('..') || value.includes('//') || value.includes('@{')).toBe(false)
          expect(value.startsWith('/') || value.endsWith('/') || value.endsWith('.')).toBe(false)
          expect(value.startsWith('.') || value.endsWith('.lock')).toBe(false)
          // Open finding F4B-1 (report): git also refuses `@` alone and a `.`-leading or `.lock`-ending component
          // after a `/` (`a/.b`, `a.lock/b`), which isAllowedBranch accepts. Those classes are not asserted until
          // the FX branch fixes it; none of them starts with `-`, so none becomes an option.
        }
        if (isAllowedRepoName(value)) {
          expect(value.startsWith('-')).toBe(false)
          expect(/^[A-Za-z0-9._-]+$/.test(value)).toBe(true)
        }
        expect(typeof value).toBe('string')
      }),
      fcParams
    )
  })
})
