// GDPR-09 (workstream D): emails, git repository owners and Windows home folders are redacted. Not a
// guarded spec: the maintainer folds these cases into test/spec/redact.test.ts (workstream G).
import { describe, expect, it } from 'vitest'
import { redact, redactString } from '../src/shared/redact'

describe('email addresses (GDPR-09)', () => {
  it('redacts an email address anywhere in a field', () => {
    expect(redactString('AADSTS50020: user anna.k+notes@contoso.co.uk is not in tenant')).toBe('AADSTS50020: user [redacted-email] is not in tenant')
    expect(redact({ account: 'Anna@Example.com' })).toEqual({ account: '[redacted-email]' })
  })

  it('keeps slate@invalid, the pseudonymous sync author', () => {
    expect(redactString('author Slate <slate@invalid>')).toBe('author Slate <slate@invalid>')
  })
})

describe('git repository owners (GDPR-09)', () => {
  it('redacts the owner and repository of an scp-style remote, with its user', () => {
    const out = redactString("fatal: Could not read from remote repository 'git@github.com:anna-k/private-notes.git'")
    expect(out).toBe("fatal: Could not read from remote repository 'github.com:[owner]/[repo]'")
  })

  it('redacts an https remote on a known host, with or without .git', () => {
    expect(redactString('remote: Repository not found. https://github.com/anna-k/private-notes.git')).toBe('remote: Repository not found. https://github.com:[owner]/[repo]')
    expect(redactString('fetch https://gitlab.com/anna/notes failed')).toBe('fetch https://gitlab.com:[owner]/[repo] failed')
    expect(redactString('url=https://bitbucket.org/team/notes.git')).toBe('url=https://bitbucket.org:[owner]/[repo]')
  })

  it('redacts a remote on any host when it ends in .git, or names a user', () => {
    expect(redactString('clone https://git.example.org/anna/notes.git')).toBe('clone https://git.example.org:[owner]/[repo]')
    expect(redactString('ssh://git@git.example.org:2222/anna/notes.git')).toContain('[owner]/[repo]')
    expect(redactString('ssh://git@git.example.org:2222/anna/notes.git')).not.toContain('anna')
    expect(redactString('push to anna@git.example.org:anna/notes')).toBe('push to git.example.org:[owner]/[repo]')
  })

  it('runs after the userinfo rule, so a remote with a token loses both', () => {
    const out = redactString('fatal: unable to access https://anna:s3cretTok3n@github.com/anna-k/private-notes.git/')
    expect(out).not.toContain('s3cretTok3n')
    expect(out).not.toContain('anna-k')
    expect(out).not.toContain('private-notes')
  })

  it('leaves source paths, relative paths and other URLs alone', () => {
    for (const s of ['packages/desktop/src/main/vault/keyring.ts', 'at Object.<anonymous> (src/main/sync/git/auth.ts:46:12)', 'see https://slate.example.org/docs/privacy', 'node_modules/loro-crdt/nodejs/loro.js:1:2'])
      expect(redactString(s), s).toBe(s)
  })
})

describe('Windows home folders (GDPR-09)', () => {
  it('rewrites any Windows home to ~, whoever it belongs to', () => {
    expect(redactString('ENOENT: C:\\Users\\anna\\AppData\\Roaming\\Slate\\slate.db')).toBe('ENOENT: ~\\AppData\\Roaming\\Slate\\slate.db')
    expect(redactString('open "d:\\Users\\bob\\notes.one"')).toBe('open "~\\notes.one"')
  })

  it('keeps a Windows path that is not under Users', () => {
    expect(redactString('C:\\Program Files\\Slate\\Slate.exe')).toBe('C:\\Program Files\\Slate\\Slate.exe')
  })
})

// The same cases as the GDPR-09 block of test/spec/redact.test.ts on gdpr/guards, so the two agree.
describe('log redaction of personal data (GDPR-09), as the spec pins it', () => {
  it('strips an email address, and keeps the pseudonymous sync identity slate@invalid', () => {
    expect(redactString('token refused for anna.k@example.com, retry')).toBe('token refused for [redacted-email], retry')
    expect(redactString('signed in as A.Person+notes@mail.example.co.uk')).toBe('signed in as [redacted-email]')
    expect(redactString('author Slate <slate@invalid>')).toBe('author Slate <slate@invalid>')
  })

  it('strips the owner and repository of an scp-style or https git remote', () => {
    for (const remote of ['git@github.com:anna-k/private-notes.git', 'https://github.com/anna-k/private-notes.git', 'https://gitlab.com/anna-k/private-notes', 'ssh://git@bitbucket.org/anna-k/private-notes.git']) {
      const out = redactString(`fatal: could not read from ${remote}`)
      expect(out, remote).toContain('[owner]/[repo]')
      expect(out, remote).not.toContain('anna-k')
      expect(out, remote).not.toContain('private-notes')
    }
  })

  it('writes a Windows home folder as ~, whoever it belongs to', () => {
    expect(redactString('cannot open C:\\Users\\anna\\AppData\\Roaming\\Slate\\slate.db')).toBe('cannot open ~\\AppData\\Roaming\\Slate\\slate.db')
    expect(redactString('d:\\Users\\Anna Person')).not.toContain('Anna')
  })
})
