import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger } from './logger'
import { filesToPrune, shouldRotate } from './rotation'
import { logHandlers } from './ipcLog'

const roots: string[] = []
const tmp = () => {
  const root = mkdtempSync(join(tmpdir(), 'slate-log-'))
  roots.push(root)
  return join(root, 'logs')
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })))

describe('Logger', () => {
  it('writes nothing, and makes no directory, while off', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: false, dir, maxSizeMb: 5 })
    l.info('app', 'hello')
    expect(existsSync(dir)).toBe(false)
  })

  it('writes a redacted line when on', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5, home: '/Users/ann' })
    l.info('sync', 'did /Users/ann/x', { path: '/Users/ann/y', n: 2 })
    const line = readFileSync(join(dir, 'slate.log'), 'utf8')
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z info {2}\[sync\] did ~\/x {"path":"~\/y","n":2}\n$/)
  })

  it('stops writing when switched off again', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    l.info('app', 'one')
    l.configure({ enabled: false, dir, maxSizeMb: 5 })
    l.info('app', 'two')
    expect(readFileSync(join(dir, 'slate.log'), 'utf8')).not.toContain('two')
  })

  it('rotates the active file once it passes a fifth of the budget', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 1 })
    for (let i = 0; i < 4000; i++) l.info('app', 'x', { pad: 'y'.repeat(400), i })
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(1)
    expect(files).toContain('slate.log')
  })

  it('swallows its own errors', () => {
    const l = new Logger()
    // A file where the directory should be: mkdir fails.
    l.configure({ enabled: true, dir: join(__filename, 'nope'), maxSizeMb: 5 })
    expect(() => l.info('app', 'x')).not.toThrow()
    const dir = tmp()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    const hostile = { get boom(): string { throw new Error('boom') } }
    expect(() => l.log('info', 'app', 'x', hostile)).not.toThrow()
  })

  it('reads and clears', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    l.info('app', 'hello')
    expect(l.read()).toContain('hello')
    l.clear()
    expect(l.read()).toBe('')
  })
})

describe('rotation', () => {
  it('rotates only a non-empty file that would pass the cap', () => {
    expect(shouldRotate(0, 10, 1024)).toBe(false)
    expect(shouldRotate(1024 * 1024, 10, 1024)).toBe(true)
  })
  it('prunes oldest archived files first until the budget fits', () => {
    const files = [
      { name: 'slate.log', bytes: 10, modifiedMs: 5 },
      { name: 'slate-a.log', bytes: 10, modifiedMs: 1 },
      { name: 'slate-b.log', bytes: 10, modifiedMs: 2 },
    ]
    expect(filesToPrune(files, { now: 10, retentionDays: 7, budgetBytes: 20, activeName: 'slate.log' })).toEqual(['slate-a.log'])
  })
})

describe('IPC rejection logging', () => {
  it('logs a rejection and rethrows it', async () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    const handlers: Record<string, (...a: unknown[]) => unknown> = {}
    const fake = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers[ch] = fn } }
    const wrapped = logHandlers(fake, l)
    wrapped.handle('x:y', () => Promise.reject(new Error('nope /Users/ann/f')))
    wrapped.handle('x:sync', () => { throw new Error('sync throw') })
    await expect(handlers['x:y']({}, 1)).rejects.toThrow('nope')
    expect(() => handlers['x:sync']({})).toThrow('sync throw')
    const text = l.read()
    expect(text).toContain('x:y')
    expect(text).toContain('ipc handler failed')
    expect(text).toContain('x:sync')
  })
})
