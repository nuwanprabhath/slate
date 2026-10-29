import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyKex, parseCurlTls, parseSshKex, remoteTransport, verboseSshCommand } from '../src/transport'
import { sshCommand } from '../src/gitRunner'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'kex', name), 'utf8')

describe('PQ-C2 observing the negotiated key exchange', () => {
  it('T-PQ-C2-01: OpenSSH 8.9, 9.6 and 10.3 verbose output name the hybrid; ecdh-sha2-nistp256 is classical', () => {
    const seen = [
      ['openssh-8.9.txt', 'sntrup761x25519-sha512@openssh.com'],
      ['openssh-9.6.txt', 'sntrup761x25519-sha512@openssh.com'],
      ['openssh-10.3.txt', 'mlkem768x25519-sha256']
    ] as const
    for (const [file, name] of seen) {
      const kex = parseSshKex(fixture(file))
      expect(kex).toBe(name)
      expect(classifyKex(kex)).toBe('hybrid')
    }
    const classical = parseSshKex(fixture('openssh-classical.txt'))
    expect(classical).toBe('ecdh-sha2-nistp256')
    expect(classifyKex(classical)).toBe('classical')
    expect(parseSshKex('debug1: kex: host key algorithm: ssh-ed25519\n')).toBeNull()
    expect(classifyKex(null)).toBe('unknown')
  })

  it('T-PQ-C2-02: a curl 8 OpenSSL 3.5 trace gives X25519MLKEM768 (hybrid); a SecureTransport trace gives unknown', () => {
    const group = parseCurlTls(fixture('curl-openssl-3.5.txt'))
    expect(group).toBe('X25519MLKEM768')
    expect(classifyKex(group)).toBe('hybrid')
    expect(classifyKex('SecP256r1MLKEM768')).toBe('hybrid')
    expect(classifyKex('SecP384r1MLKEM1024')).toBe('hybrid')
    expect(classifyKex(parseCurlTls('== Info: SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384 / X25519 / RSASSA-PSS'))).toBe('classical')
    const none = parseCurlTls(fixture('curl-securetransport.txt'))
    expect(none).toBeNull()
    expect(classifyKex(none)).toBe('unknown')
  })

  it('the parsers return only the algorithm name, never a header from the trace', () => {
    const trace = fixture('curl-openssl-3.5.txt')
    expect(JSON.stringify([parseCurlTls(trace), classifyKex(parseCurlTls(trace))])).not.toMatch(/Authorization|basic/i)
  })

  it('host-level remote ids drop user, path, query and default ports', () => {
    expect(remoteTransport('git@github.com:o/r.git')).toEqual({ kind: 'ssh', remote: 'git-ssh:github.com' })
    expect(remoteTransport('ssh://git@GitHub.com:22/o/r.git')).toEqual({ kind: 'ssh', remote: 'git-ssh:github.com' })
    expect(remoteTransport('ssh://git@git.example.org:2222/o/r.git')).toEqual({ kind: 'ssh', remote: 'git-ssh:git.example.org:2222' })
    expect(remoteTransport('https://user:tok@github.com/o/r.git?x=1')).toEqual({ kind: 'https', remote: 'git-https:github.com' })
    expect(remoteTransport('https://gitlab.example.com:8443/o/r.git')).toEqual({ kind: 'https', remote: 'git-https:gitlab.example.com:8443' })
    expect(remoteTransport('file:///tmp/r.git')).toBeNull()
    expect(remoteTransport('/tmp/r.git')).toBeNull()
    expect(remoteTransport('C:\\repos\\r.git')).toBeNull()
  })

  it('-v is appended only to a command sshCommand builds', () => {
    const built = sshCommand({ hybrid: ['mlkem768x25519-sha256'], ssh: null, prepend: true }, 'prefer')
    expect(verboseSshCommand(built)).toBe(`${built} -v`)
    expect(verboseSshCommand('ssh -o BatchMode=yes')).toBe('ssh -o BatchMode=yes -v')
    expect(() => verboseSshCommand('ssh -o BatchMode=yes; touch /tmp/x')).toThrow(/refused/)
    expect(() => verboseSshCommand('ssh -o ProxyCommand=evil')).toThrow(/refused/)
  })
})
