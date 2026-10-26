import { describe, expect, it } from 'vitest'
import { runFile, spawnProgram } from './proc'

describe('proc: programs start without a shell', () => {
  it('passes arguments through literally, even when a caller smuggles in shell: true', async () => {
    const { stdout } = await runFile('/bin/echo', ['$HOME', '`id`', 'a;b'], { shell: true } as never)
    expect(stdout).toBe('$HOME `id` a;b\n')
  })

  it('rejects on a failing program with its stderr', async () => {
    await expect(runFile('/bin/ls', ['/definitely/not/here'])).rejects.toMatchObject({ stderr: expect.stringMatching(/not/) as unknown })
  })

  it('refuses a shell given a command string, whatever its path (red team re-run 7a residual)', async () => {
    for (const [file, args] of [['/bin/sh', ['-c', 'echo x']], ['bash', ['-lc', 'id']], ['/usr/bin/zsh', ['-c', 'id']], ['cmd.exe', ['/c', 'dir']], ['pwsh', ['-Command', 'ls']]] as const) {
      await expect(runFile(file, args), file).rejects.toThrow(/shell/)
      expect(() => spawnProgram(file, args), file).toThrow(/shell/)
    }
  })

  it('spawns with the shell option forced off', () => {
    const child = spawnProgram('/bin/echo', ['$HOME'], { shell: '/bin/sh' } as never)
    expect(child.spawnargs).toEqual(['/bin/echo', '$HOME'])
    child.kill()
  })
})
