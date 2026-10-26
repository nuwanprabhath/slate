import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  it('never writes key bytes: the fields type refuses bytes, and key text is redacted (red team 5a)', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    const mk = Buffer.alloc(32, 0xa3)
    // @ts-expect-error -- LogFields holds plain data only; a Buffer (a key) does not type-check
    l.info('sync', 'unlocked', { key: mk })
    l.info('sync', `master key ${mk.toString('hex')}`, { qu: mk.toString('base64') })
    const text = readFileSync(join(dir, 'slate.log'), 'utf8')
    expect(text).not.toContain(mk.toString('hex'))
    expect(text).not.toContain(mk.toString('base64'))
    expect(text).toContain('[redacted-hex]')
  })

  it('keeps its folder 0700 and every file 0600, also when they existed looser (review C10 low)', () => {
    const dir = tmp()
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'slate.log'), 'old\n', { mode: 0o644 })
    chmodSync(join(dir, 'slate.log'), 0o644)
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    l.info('app', 'x'.repeat(100))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'slate.log')).mode & 0o777).toBe(0o600)
    // A rotation's new active file is owner-only too.
    for (let i = 0; i < 3000; i++) l.info('app', 'x', { pad: 'y'.repeat(400), i })
    const names = readdirSync(dir)
    expect(names.length).toBeGreaterThan(1)
    for (const n of names) expect(statSync(join(dir, n)).mode & 0o777).toBe(0o600)
  }, 30_000)

  it('makes a fresh folder 0700 whatever the umask allows', () => {
    const dir = tmp()
    const l = new Logger()
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    l.info('app', 'hello')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'slate.log')).mode & 0o777).toBe(0o600)
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
    l.configure({ enabled: true, dir, maxSizeMb: 5 })
    for (let i = 0; i < 4000; i++) l.info('app', 'x', { pad: 'y'.repeat(400), i })
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(1)
    expect(files).toContain('slate.log')
    // 4000 synchronous appends: well over vitest's 5 s default on a loaded machine.
  }, 30_000)

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
    await expect(handlers['x:y']!({}, 1)).rejects.toThrow('nope')
    expect(() => handlers['x:sync']!({})).toThrow('sync throw')
    const text = l.read()
    expect(text).toContain('x:y')
    expect(text).toContain('ipc handler failed')
    expect(text).toContain('x:sync')
  })
})
