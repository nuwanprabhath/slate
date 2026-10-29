import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probeSshKex, sshCommand } from '../src/gitRunner'

describe('PQ-C1 against the real ssh (offline: ssh -G only)', () => {
  it('T-PQ-C1-06: the command built for this machine passes ssh -G and offers the chosen hybrid first', async () => {
    const probe = await probeSshKex()
    const command = sshCommand(probe, 'prefer')
    const [program, ...options] = command.split(' ')
    expect(program).toBe('ssh')
    // -F none: the user's config cannot change the answer or run a Match exec; -G never connects.
    const result = spawnSync('ssh', ['-F', 'none', ...options, '-G', 'slate-probe.invalid'], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    const kexLine = result.stdout.split('\n').find((line) => line.startsWith('kexalgorithms ')) ?? ''
    expect(kexLine).not.toBe('')
    const offered = kexLine.slice('kexalgorithms '.length).split(',')
    const chosen = probe.hybrid[0]
    // Every OpenSSH since 9.0 has sntrup, and both CI runners ship one, so a hybrid is always chosen here.
    expect(chosen).toBeDefined()
    expect(offered[0]).toBe(chosen)
    // The probe is once per process.
    expect(await probeSshKex()).toBe(probe)
  })
})
