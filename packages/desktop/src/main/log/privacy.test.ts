// GDPR-08 and GDPR-13 (workstream D): the diagnostic log is pruned even while off and deleted when
// strict mode switches it off; the security log keeps 30 days in strict mode, 90 under fips-140-3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => paths.userData, getVersion: () => '0.0.0-test' },
  clipboard: {},
  shell: {},
}))

import { Logger, log, securityLog } from './logger'
import { applySecurityLogRetention, configureLogging, configureSecurityLog } from './configure'

const DAY = 24 * 60 * 60 * 1000
let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slate-log-privacy-'))
  paths.userData = root
})
afterEach(() => {
  log.configure({ enabled: false, dir: '', maxSizeMb: 20 })
  securityLog.configure({ enabled: false, dir: '', maxSizeMb: 2 })
  rmSync(root, { recursive: true, force: true })
})

function aged(dir: string, name: string, daysAgo: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, 'line\n')
  const when = (Date.now() - daysAgo * DAY) / 1000
  utimesSync(file, when, when)
}

describe('Logger while off (GDPR-13)', () => {
  it('configure prunes old files in an existing folder even with the log off', () => {
    const dir = join(root, 'logs')
    aged(dir, 'slate-2020-01-01.log', 30)
    aged(dir, 'slate-recent.log', 1)
    const logger = new Logger()
    logger.configure({ enabled: false, dir, maxSizeMb: 20 })
    expect(readdirSync(dir)).toEqual(['slate-recent.log'])
  })

  it('configure with the log off never creates the folder', () => {
    const dir = join(root, 'logs')
    new Logger().configure({ enabled: false, dir, maxSizeMb: 20 })
    expect(existsSync(dir)).toBe(false)
  })

  it('purgeAll removes every log file and the folder itself', () => {
    const dir = join(root, 'logs')
    const logger = new Logger()
    logger.configure({ enabled: true, dir, maxSizeMb: 20 })
    logger.info('app', 'hello')
    aged(dir, 'slate-old.log', 2)
    logger.purgeAll()
    expect(existsSync(dir)).toBe(false)
  })

  it('purgeAll leaves a folder holding something that is not a log', () => {
    const dir = join(root, 'logs')
    const logger = new Logger()
    logger.configure({ enabled: true, dir, maxSizeMb: 20 })
    logger.info('app', 'hello')
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    logger.purgeAll()
    expect(readdirSync(dir)).toEqual(['keep.txt'])
  })
})

describe('configureLogging (GDPR-13)', () => {
  const logs = () => join(root, 'logs')

  it('deletes the log when strict mode switches it from on to off', () => {
    configureLogging({ debugLog: true, gdprStrictMode: true })
    log.info('app', 'something')
    expect(existsSync(join(logs(), 'slate.log'))).toBe(true)
    configureLogging({ debugLog: false, gdprStrictMode: true })
    expect(existsSync(logs())).toBe(false)
  })

  it('keeps the files when strict mode is off, and still prunes them', () => {
    configureLogging({ debugLog: true, gdprStrictMode: false })
    log.info('app', 'something')
    aged(logs(), 'slate-ancient.log', 30)
    configureLogging({ debugLog: false, gdprStrictMode: false })
    expect(readdirSync(logs())).toEqual(['slate.log'])
  })

  it('deletes nothing when the log was already off', () => {
    aged(logs(), 'slate.log', 0)
    configureLogging({ debugLog: false, gdprStrictMode: true })
    expect(readdirSync(logs())).toEqual(['slate.log'])
  })
})

describe('applySecurityLogRetention (GDPR-08)', () => {
  const dir = () => join(root, 'security-log')

  it('keeps 90 days without strict mode', () => {
    configureSecurityLog()
    aged(dir(), 'slate-a.log', 40)
    applySecurityLogRetention('standard', false)
    expect(readdirSync(dir())).toContain('slate-a.log')
  })

  it('keeps 30 days for standard in strict mode, and with no vault', () => {
    configureSecurityLog()
    aged(dir(), 'slate-a.log', 40)
    aged(dir(), 'slate-b.log', 20)
    applySecurityLogRetention('standard', true)
    expect(readdirSync(dir())).not.toContain('slate-a.log')
    expect(readdirSync(dir())).toContain('slate-b.log')
    aged(dir(), 'slate-c.log', 40)
    applySecurityLogRetention(null, true)
    expect(readdirSync(dir())).not.toContain('slate-c.log')
  })

  it('keeps 90 days under fips-140-3, strict mode or not', () => {
    configureSecurityLog()
    aged(dir(), 'slate-a.log', 40)
    applySecurityLogRetention('fips-140-3', true)
    expect(readdirSync(dir())).toContain('slate-a.log')
    aged(dir(), 'slate-old.log', 100)
    applySecurityLogRetention('fips-140-3', true)
    expect(readdirSync(dir())).not.toContain('slate-old.log')
  })

  it('keeps writing to the security log after the change', () => {
    configureSecurityLog()
    applySecurityLogRetention('standard', true)
    securityLog.info('app', 'unlock')
    expect(securityLog.read()).toContain('unlock')
  })
})
