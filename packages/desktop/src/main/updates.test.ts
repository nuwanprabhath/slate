import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startUpdates, updateConfig } from './updates'

describe('updateConfig', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'slate-update-'))

  it('is null when update.json is missing, empty or has no url', () => {
    const d = dir()
    expect(updateConfig(d)).toBeNull()
    writeFileSync(join(d, 'update.json'), '')
    expect(updateConfig(d)).toBeNull()
    writeFileSync(join(d, 'update.json'), '{"url":""}')
    expect(updateConfig(d)).toBeNull()
    writeFileSync(join(d, 'update.json'), 'not json')
    expect(updateConfig(d)).toBeNull()
  })

  it('returns the url of a valid file', () => {
    const d = dir()
    writeFileSync(join(d, 'update.json'), '{"url":"https://updates.example.com/slate"}')
    expect(updateConfig(d)).toEqual({ url: 'https://updates.example.com/slate' })
  })
})

describe('startUpdates', () => {
  afterEach(() => vi.useRealTimers())

  const fakeUpdater = () => ({ checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null), on: vi.fn() })

  it('checks once 10 seconds after start, then every 6 hours', () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const handle = startUpdates({ url: 'https://u' }, { updater, log: vi.fn() })
    vi.advanceTimersByTime(9_999)
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6 * 3600_000)
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2)
    handle.stop()
    vi.advanceTimersByTime(12 * 3600_000)
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2)
  })

  it('never checks when the config is null', () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const handle = startUpdates(null, { updater, log: vi.fn() })
    vi.advanceTimersByTime(24 * 3600_000)
    handle.checkNow()
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    expect(handle.enabled).toBe(false)
  })

  it('checks on demand and logs errors instead of throwing', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdatesAndNotify.mockRejectedValue(new Error('offline'))
    const log = vi.fn()
    const handle = startUpdates({ url: 'https://u' }, { updater, log })
    handle.checkNow()
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(String(log.mock.calls[0][0])).toContain('offline')
    handle.stop()
  })
})
