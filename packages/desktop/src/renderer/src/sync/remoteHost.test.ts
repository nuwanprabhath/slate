import { describe, expect, it } from 'vitest'
import { isGitHubRemote } from './remoteHost'

describe('isGitHubRemote', () => {
  it('knows GitHub by the remote host, over https, ssh and the scp form', () => {
    for (const remote of ['https://github.com/me/notes.git', 'ssh://git@github.com/me/notes.git', 'git@github.com:me/notes.git', 'https://GitHub.com/me/notes']) expect(isGitHubRemote(remote), remote).toBe(true)
  })

  it('does not take github.com elsewhere in the address for the host', () => {
    for (const remote of ['https://git.example/github.com/notes.git', 'https://github.com.example/me/notes', 'git@example.org:github.com/notes', 'https://notgithub.com/me/notes', '', 'not a url']) expect(isGitHubRemote(remote), remote).toBe(false)
  })
})
