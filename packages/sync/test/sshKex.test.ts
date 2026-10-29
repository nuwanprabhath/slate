import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { nodeGitRunner, PqTransportUnavailable, probeSshKex, sshCommand, type SshKexProbe } from '../src/gitRunner'

/** What INV-PQ-6 allows into GIT_SSH_COMMAND, which git hands to /bin/sh. */
const SAFE_COMMAND = /^ssh -o BatchMode=yes( -o KexAlgorithms=\^?[a-z0-9@.,-]+)?$/

const OPENSSH_10_3 = [
  'diffie-hellman-group1-sha1',
  'diffie-hellman-group14-sha256',
  'diffie-hellman-group16-sha512',
  'ecdh-sha2-nistp256',
  'curve25519-sha256',
  'curve25519-sha256@libssh.org',
  'sntrup761x25519-sha512',
  'sntrup761x25519-sha512@openssh.com',
  'mlkem768x25519-sha256'
].join('\n')
const OPENSSH_8_9 = ['ecdh-sha2-nistp256', 'curve25519-sha256', 'sntrup761x25519-sha512@openssh.com'].join('\n')
const OPENSSH_8_4 = ['ecdh-sha2-nistp256', 'curve25519-sha256', 'curve25519-sha256@libssh.org'].join('\n')

interface Reply {
  code: number
  stdout?: string
  stderr?: string
}
type Script = (args: readonly string[]) => Reply | 'ENOENT'

/** A spawn that answers `ssh` invocations from a script and records each argument list. */
function fakeSpawn(script: Script): { spawnFn: typeof spawn; calls: string[][] } {
  const calls: string[][] = []
  const fn = (command: string, args: readonly string[]) => {
    expect(command).toBe('ssh')
    calls.push([...args])
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => true
    })
    const reply = script(args)
    setImmediate(() => {
      if (reply === 'ENOENT') {
        child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))
        return
      }
      child.stdout.end(reply.stdout ?? '')
      child.stderr.end(reply.stderr ?? '')
      child.emit('close', reply.code)
    })
    return child
  }
  return { spawnFn: fn as unknown as typeof spawn, calls }
}

/** An OpenSSH that lists `kexList`, prints `version`, and accepts every `-G` unless `rejectG` says no. */
function openssh(kexList: string, opts: { rejectG?: (kex: string) => boolean; version?: string } = {}): Script {
  return (args) => {
    if (args[0] === '-V') return { code: 0, stderr: `${opts.version ?? 'OpenSSH_10.3p1, LibreSSL 3.3.6'}\n` }
    if (args[0] === '-Q' && args[1] === 'kex') return { code: 0, stdout: `${kexList}\n` }
    if (args.includes('-G')) {
      const kex = args.find((a) => a.startsWith('KexAlgorithms=')) ?? ''
      if (opts.rejectG?.(kex)) return { code: 255, stderr: `command-line line 0: Bad SSH2 KexAlgorithms '${kex}'.\n` }
      return { code: 0, stdout: `kexalgorithms ${kex.slice('KexAlgorithms='.length).replace(/^\^/, '')}\n` }
    }
    return { code: 255, stderr: 'unexpected\n' }
  }
}

describe('PQ-C1 hybrid SSH key exchange for git', () => {
  it('T-PQ-C1-01: OpenSSH 10.3 prefers ML-KEM then sntrup (the @openssh.com alias only), prepended to the default list', async () => {
    const { spawnFn, calls } = fakeSpawn(openssh(OPENSSH_10_3))
    const probe = await probeSshKex(spawnFn)
    expect(probe.hybrid).toEqual(['mlkem768x25519-sha256', 'sntrup761x25519-sha512@openssh.com'])
    expect(probe.ssh).toBe('OpenSSH_10.3p1')
    expect(sshCommand(probe, 'prefer')).toBe(
      'ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com'
    )
    // The prepend form was validated offline, against a name that cannot resolve and with no config file read.
    expect(calls).toContainEqual([
      '-F',
      'none',
      '-G',
      '-o',
      'BatchMode=yes',
      '-o',
      'KexAlgorithms=^mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com',
      'slate-probe.invalid'
    ])
  })

  it('T-PQ-C1-02: OpenSSH 8.9 gets sntrup only; OpenSSH 8.4 (no hybrid) keeps the command used today', async () => {
    const old = await probeSshKex(fakeSpawn(openssh(OPENSSH_8_9, { version: 'OpenSSH_8.9p1 Ubuntu-3ubuntu0.10, OpenSSL 3.0.2 15 Mar 2022' })).spawnFn)
    expect(old.hybrid).toEqual(['sntrup761x25519-sha512@openssh.com'])
    expect(old.ssh).toBe('OpenSSH_8.9p1')
    expect(sshCommand(old, 'prefer')).toBe('ssh -o BatchMode=yes -o KexAlgorithms=^sntrup761x25519-sha512@openssh.com')

    const older = await probeSshKex(fakeSpawn(openssh(OPENSSH_8_4, { version: 'OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w' })).spawnFn)
    expect(older.hybrid).toEqual([])
    expect(sshCommand(older, 'prefer')).toBe('ssh -o BatchMode=yes')

    // A plain-named sntrup alone is kept: it is the only spelling that build knows.
    const plain = await probeSshKex(fakeSpawn(openssh('curve25519-sha256\nsntrup761x25519-sha512')).spawnFn)
    expect(plain.hybrid).toEqual(['sntrup761x25519-sha512'])

    // No ssh at all: no hybrid, no version, today's command.
    const none = await probeSshKex(fakeSpawn(() => 'ENOENT').spawnFn)
    expect(none).toMatchObject({ hybrid: [], ssh: null })
    expect(sshCommand(none, 'prefer')).toBe('ssh -o BatchMode=yes')
  })

  it('T-PQ-C1-03: probe lines carrying shell syntax are ignored and never reach the command (INV-PQ-6)', async () => {
    const hostile = [
      'mlkem768x25519-sha256;touch /tmp/x',
      '$(id)',
      ' sntrup761x25519-sha512@openssh.com`id`',
      'mlkem768x25519-sha256 && id',
      'curve25519-sha256'
    ].join('\n')
    const hostileProbe = await probeSshKex(fakeSpawn(openssh(hostile, { version: 'OpenSSH_9.9$(id)' })).spawnFn)
    expect(hostileProbe.hybrid).toEqual([])
    expect(sshCommand(hostileProbe, 'prefer')).toMatch(SAFE_COMMAND)
    expect(hostileProbe.ssh).not.toMatch(/[$()`;&|]/)

    // Hostile lines next to real ones: only the real ones count, and only PQ_KEX's own strings are written.
    const mixed = await probeSshKex(fakeSpawn(openssh(`${hostile}\r\nmlkem768x25519-sha256\r\n`)).spawnFn)
    expect(mixed.hybrid).toEqual(['mlkem768x25519-sha256'])
    for (const policy of ['prefer', 'require'] as const) {
      const command = sshCommand(mixed, policy)
      expect(command).toMatch(SAFE_COMMAND)
      expect(command).not.toMatch(/touch|id\)|`|;|&/)
    }

    // A probe object forged by a caller cannot smuggle text either.
    const forged = { ...mixed, hybrid: ['mlkem768x25519-sha256;touch /tmp/x'] } as unknown as SshKexProbe
    expect(sshCommand(forged, 'prefer')).toBe('ssh -o BatchMode=yes')
    expect(() => sshCommand(forged, 'require')).toThrow(PqTransportUnavailable)
  })

  it('T-PQ-C1-04: require refuses without a hybrid and lists only hybrids (no ^) when there is one', async () => {
    const older = await probeSshKex(fakeSpawn(openssh(OPENSSH_8_4)).spawnFn)
    expect(() => sshCommand(older, 'require')).toThrow(PqTransportUnavailable)
    try {
      sshCommand(older, 'require')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('PqTransportUnavailable')
    }

    const modern = await probeSshKex(fakeSpawn(openssh(OPENSSH_10_3)).spawnFn)
    expect(sshCommand(modern, 'require')).toBe(
      'ssh -o BatchMode=yes -o KexAlgorithms=mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com'
    )
  })

  it('T-PQ-C1-05: an ssh that rejects ^ gets the explicit list, which itself passed ssh -G', async () => {
    const { spawnFn, calls } = fakeSpawn(openssh(OPENSSH_8_9, { rejectG: (kex) => kex.startsWith('KexAlgorithms=^') }))
    const probe = await probeSshKex(spawnFn)
    const explicit =
      'sntrup761x25519-sha512@openssh.com,curve25519-sha256,ecdh-sha2-nistp256,ecdh-sha2-nistp384,diffie-hellman-group16-sha512'
    expect(probe.hybrid).toEqual(['sntrup761x25519-sha512@openssh.com'])
    expect(sshCommand(probe, 'prefer')).toBe(`ssh -o BatchMode=yes -o KexAlgorithms=${explicit}`)
    expect(sshCommand(probe, 'require')).toBe('ssh -o BatchMode=yes -o KexAlgorithms=sntrup761x25519-sha512@openssh.com')
    const validated = calls.filter((args) => args.includes('-G')).map((args) => args.find((a) => a.startsWith('KexAlgorithms=')))
    expect(validated).toEqual(['KexAlgorithms=^sntrup761x25519-sha512@openssh.com', `KexAlgorithms=${explicit}`])

    // If ssh -G rejects both forms, the hybrids are not offered at all.
    const broken = await probeSshKex(fakeSpawn(openssh(OPENSSH_10_3, { rejectG: () => true })).spawnFn)
    expect(broken.hybrid).toEqual([])
    expect(sshCommand(broken, 'prefer')).toBe('ssh -o BatchMode=yes')
  })

  it('T-PQ-C1-07: nodeGitRunner hands git the given ssh command, and keeps today\'s command without one', async () => {
    const command = 'ssh -o BatchMode=yes -o KexAlgorithms=^mlkem768x25519-sha256'
    const withKex = await nodeGitRunner('printenv', { sshCommand: command })(['GIT_SSH_COMMAND'])
    expect(new TextDecoder().decode(withKex.stdout).trim()).toBe(command)
    const today = await nodeGitRunner('printenv')(['GIT_SSH_COMMAND'])
    expect(new TextDecoder().decode(today.stdout).trim()).toBe('ssh -o BatchMode=yes')
    // Anything sshCommand could not have built is refused before git ever runs.
    expect(() => nodeGitRunner('printenv', { sshCommand: 'ssh -o BatchMode=yes; touch /tmp/x' })).toThrow(/GIT_SSH_COMMAND/)
  })
})
