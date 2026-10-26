// Z-9 (audit §4.3, C7 criterion 4): the module makes the process leave no core file, and on Linux makes
// it non-dumpable, so other processes of the same user can neither read its memory nor attach to it.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('hardenProcess (Z-9)', () => {
  it('sets RLIMIT_CORE to 0, and PR_SET_DUMPABLE to 0 on Linux', () => {
    // Raise the soft limit first where the shell allows it, so the change shows whatever the default was.
    const child = join(__dirname, 'hardenChild.mjs')
    const r = spawnSync('/bin/sh', ['-c', 'ulimit -c unlimited 2>/dev/null; exec "$0" "$1"', process.execPath, child], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const got = JSON.parse(r.stdout) as { hardened: boolean; after: { coreLimit: string; procOwner: number | null } }
    expect(got.hardened).toBe(true)
    expect(got.after.coreLimit).toBe('0')
    // Linux only: /proc/<pid> of a non-dumpable process is owned by root.
    expect(got.after.procOwner).toBe(process.platform === 'linux' ? 0 : null)
  })
})
