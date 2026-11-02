import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { followSettings } from './settingsFeed'

const withShortcuts = (on: boolean): Settings => ({ ...DEFAULT_SETTINGS, markdownShortcuts: on })

/** A settings API whose first read the test releases by hand, and whose changes it sends by hand. */
function fakeApi() {
  let release!: (s: Settings) => void
  let send: ((s: Settings) => void) | undefined
  const off = vi.fn()
  return {
    api: {
      get: () => new Promise<Settings>((resolve) => { release = resolve }),
      onChange: (handler: (s: Settings) => void) => {
        send = handler
        return off
      },
    },
    release: (s: Settings) => release(s),
    send: (s: Settings) => send?.(s),
    off,
  }
}

describe('followSettings', () => {
  it('applies the first read, then each change', async () => {
    const { api, release, send } = fakeApi()
    const apply = vi.fn()
    followSettings(api, apply)
    release(withShortcuts(false))
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    send(withShortcuts(true))
    expect(apply.mock.calls.map(([s]) => (s as Settings).markdownShortcuts)).toEqual([false, true])
  })

  it('does not let a first read that arrives after a change overwrite it', async () => {
    const { api, release, send } = fakeApi()
    const apply = vi.fn()
    followSettings(api, apply)
    // The menu toggle: main announces the change while the first read, taken before it, is still on its way.
    send(withShortcuts(true))
    release(withShortcuts(false))
    await Promise.resolve()
    await Promise.resolve()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(withShortcuts(true))
  })

  it('returns the unsubscribe', () => {
    const { api, off } = fakeApi()
    followSettings(api, vi.fn())()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
