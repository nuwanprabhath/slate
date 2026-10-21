import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LOCK_FILE, runningHolder } from './lock'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-lock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('slate.lock', () => {
  it('is written with our pid and removed on release', () => {
    const release = acquireLock(dir)
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true)
    expect(runningHolder(dir, 999_999_999)).toBe(process.pid)
    release()
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
  })

  it('reports no holder when there is no lock, a dead pid or garbage', () => {
    expect(runningHolder(dir)).toBeNull()
    writeFileSync(join(dir, LOCK_FILE), '2147483646')
    expect(runningHolder(dir)).toBeNull()
    writeFileSync(join(dir, LOCK_FILE), 'not a pid')
    expect(runningHolder(dir)).toBeNull()
  })

  it('does not count the asking process itself', () => {
    const release = acquireLock(dir)
    expect(runningHolder(dir, process.pid)).toBeNull()
    release()
  })

  it('release leaves a lock another process has taken over', () => {
    const release = acquireLock(dir)
    writeFileSync(join(dir, LOCK_FILE), '1')
    release()
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true)
  })
})
