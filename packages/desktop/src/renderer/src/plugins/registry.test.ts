import { describe, expect, it, vi } from 'vitest'
import type { AppApi, SettingsBackend } from './types'
import { matchesKeybinding, PluginRegistry } from './registry'

const app: AppApi = {
  openPage: () => {},
  getLibrary: () => [],
  currentNotebookId: () => null,
  search: async () => ({ pages: [], total: 0, truncated: false }),
  replaceInPages: async () => ({ replaced: 0, pages: 0, skipped: 0, failed: 0 }),
  previewReplacements: async () => new Map(),
}

function memorySettings(): SettingsBackend & { data: { plugins?: Record<string, unknown> } } {
  const data: { plugins?: Record<string, unknown> } = {}
  return {
    data,
    get: async () => ({ ...data.plugins }),
    set: async (plugins) => void (data.plugins = plugins),
  }
}

const key = (k: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent

describe('PluginRegistry', () => {
  it('lists views from every plugin sorted by order', () => {
    const r = new PluginRegistry(app, memorySettings())
    r.activate({ id: 'b', name: 'B', activate: (ctx) => ctx.views.register({ id: 'b.main', title: 'B', icon: null, order: 20, render: () => null }) })
    r.activate({ id: 'a', name: 'A', activate: (ctx) => ctx.views.register({ id: 'a.main', title: 'A', icon: null, order: 10, render: () => null }) })
    expect(r.views().map((v) => v.id)).toEqual(['a.main', 'b.main'])
  })

  it('notifies subscribers when a view arrives, and keeps the same list otherwise', () => {
    const r = new PluginRegistry(app, memorySettings())
    const listener = vi.fn()
    r.subscribe(listener)
    const before = r.views()
    expect(r.views()).toBe(before)
    r.activate({ id: 'a', name: 'A', activate: (ctx) => ctx.views.register({ id: 'a.main', title: 'A', icon: null, order: 1, render: () => null }) })
    expect(listener).toHaveBeenCalled()
    expect(r.views()).not.toBe(before)
  })

  it('a plugin that throws contributes nothing and the others still load', () => {
    const r = new PluginRegistry(app, memorySettings())
    r.activate({ id: 'bad', name: 'Bad', activate: () => { throw new Error('boom') } })
    r.activate({ id: 'ok', name: 'Ok', activate: (ctx) => ctx.views.register({ id: 'ok.main', title: 'Ok', icon: null, order: 1, render: () => null }) })
    expect(r.views().map((v) => v.id)).toEqual(['ok.main'])
  })

  it('runs a command from its keybinding and swallows the key', () => {
    const r = new PluginRegistry(app, memorySettings())
    const run = vi.fn()
    r.activate({ id: 's', name: 'S', activate: (ctx) => ctx.commands.register({ id: 's.open', title: 'Open', keybinding: 'Mod+Shift+F', run }) })
    expect(r.handleKey(key('f', { metaKey: true }), true)).toBe(false)
    expect(r.handleKey(key('F', { metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(r.handleKey(key('F', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    r.runCommand('s.open')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('keeps each plugin settings under plugins.<id>.*', async () => {
    const settings = memorySettings()
    const r = new PluginRegistry(app, settings)
    let ctxSettings: Parameters<Parameters<PluginRegistry['activate']>[0]['activate']>[0]['settings'] | undefined
    r.activate({ id: 'search', name: 'Search', activate: (ctx) => void (ctxSettings = ctx.settings) })
    await ctxSettings!.set('scope', { kind: 'all' })
    expect(settings.data.plugins).toEqual({ 'plugins.search.scope': { kind: 'all' } })
    expect(await ctxSettings!.get('scope')).toEqual({ kind: 'all' })
    expect(await ctxSettings!.get('missing')).toBeUndefined()
  })

  it('refuses a view or command id that does not carry its plugin prefix', () => {
    const errors: string[] = []
    const r = new PluginRegistry(app, memorySettings(), (where, e) => errors.push(`${where}: ${String(e)}`))
    r.activate({ id: 'notes', name: 'Notes', activate: (ctx) => ctx.views.register({ id: 'panel', title: 'P', icon: null, order: 1, render: () => null }) })
    r.activate({ id: 'notes', name: 'Notes', activate: (ctx) => ctx.commands.register({ id: 'open', title: 'Open', run: () => {} }) })
    expect(r.views()).toEqual([])
    expect(errors.join('\n')).toContain('"notes."')
  })

  it('refuses a duplicate view id, naming both plugins', () => {
    const errors: string[] = []
    const r = new PluginRegistry(app, memorySettings(), (where, e) => errors.push(`${where}: ${String(e)}`))
    const view = { title: 'P', icon: null, order: 1, render: () => null }
    r.activate({ id: 'one', name: 'One', activate: (ctx) => ctx.views.register({ id: 'one.panel', ...view }) })
    r.activate({ id: 'one', name: 'Two', activate: (ctx) => ctx.views.register({ id: 'one.panel', ...view }) })
    expect(r.views().map((v) => v.id)).toEqual(['one.panel'])
    expect(errors.join('\n')).toContain('one.panel')
  })

  it('refuses a duplicate command id and a duplicate keybinding, naming both plugins', () => {
    const errors: string[] = []
    const r = new PluginRegistry(app, memorySettings(), (where, e) => errors.push(`${where}: ${String(e)}`))
    const kept = vi.fn()
    const lost = vi.fn()
    r.activate({ id: 'a', name: 'A', activate: (ctx) => ctx.commands.register({ id: 'a.go', title: 'Go', keybinding: 'Mod+Shift+G', run: kept }) })
    r.activate({ id: 'b', name: 'B', activate: (ctx) => ctx.commands.register({ id: 'b.go', title: 'Go', keybinding: 'Mod+Shift+G', run: lost }) })
    r.activate({ id: 'a', name: 'A again', activate: (ctx) => ctx.commands.register({ id: 'a.go', title: 'Go', run: lost }) })
    r.handleKey(key('G', { metaKey: true, shiftKey: true }), true)
    r.runCommand('a.go')
    expect(kept).toHaveBeenCalledTimes(2)
    expect(lost).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/"b"/)
  })

  it('deactivate removes a plugin view, its command and its key handling, newest first', () => {
    const r = new PluginRegistry(app, memorySettings())
    const run = vi.fn()
    const order: string[] = []
    r.activate({
      id: 's',
      name: 'S',
      activate: (ctx) => {
        ctx.views.register({ id: 's.panel', title: 'S', icon: null, order: 1, render: () => null })
        ctx.commands.register({ id: 's.open', title: 'Open', keybinding: 'Mod+Shift+F', run })
        return { dispose: () => order.push('plugin') }
      },
    })
    expect(r.views().map((v) => v.id)).toEqual(['s.panel'])
    r.deactivate('s')
    expect(order).toEqual(['plugin'])
    expect(r.views()).toEqual([])
    expect(r.handleKey(key('F', { metaKey: true, shiftKey: true }), true)).toBe(false)
    r.runCommand('s.open')
    expect(run).not.toHaveBeenCalled()
  })

  it('frees an id when its own Disposable is disposed, so another plugin may take it', () => {
    const r = new PluginRegistry(app, memorySettings())
    let handle: { dispose(): void } | undefined
    r.activate({ id: 'a', name: 'A', activate: (ctx) => void (handle = ctx.views.register({ id: 'a.panel', title: 'A', icon: null, order: 1, render: () => null })) })
    handle!.dispose()
    handle!.dispose()
    expect(r.views()).toEqual([])
  })

  it('persists every one of twenty concurrent settings writes', async () => {
    const settings = memorySettings()
    const r = new PluginRegistry(app, settings)
    let ctxSettings: Parameters<Parameters<PluginRegistry['activate']>[0]['activate']>[0]['settings'] | undefined
    r.activate({ id: 'search', name: 'Search', activate: (ctx) => void (ctxSettings = ctx.settings) })
    const keys = Array.from({ length: 20 }, (_, i) => `k${String(i)}`)
    await Promise.all(keys.map((k) => ctxSettings!.set(k, k)))
    expect(Object.keys(settings.data.plugins ?? {})).toHaveLength(20)
    expect(await ctxSettings!.get('k19')).toBe('k19')
  })

  it('contains a command that throws and keeps the registry working', () => {
    const errors: string[] = []
    const r = new PluginRegistry(app, memorySettings(), (where, e) => errors.push(`${where}: ${String(e)}`))
    const after = vi.fn()
    r.activate({ id: 'bad', name: 'Bad', activate: (ctx) => ctx.commands.register({ id: 'bad.go', title: 'Go', keybinding: 'Mod+Shift+B', run: () => { throw new Error('boom') } }) })
    r.activate({ id: 'ok', name: 'Ok', activate: (ctx) => ctx.commands.register({ id: 'ok.go', title: 'Go', run: after }) })
    expect(r.handleKey(key('B', { metaKey: true, shiftKey: true }), true)).toBe(true)
    r.runCommand('ok.go')
    expect(after).toHaveBeenCalledTimes(1)
    expect(errors.join('\n')).toContain('bad.go')
  })

  it('tells a plugin a page opened and that the vault will lock, until it is deactivated', () => {
    const r = new PluginRegistry(app, memorySettings())
    const opened = vi.fn()
    const locking = vi.fn()
    r.activate({
      id: 'w',
      name: 'W',
      activate: (ctx) => {
        ctx.onPageOpened(opened)
        ctx.onWillLock(locking)
      },
    })
    r.pageOpened('page-1')
    r.willLock()
    expect(opened).toHaveBeenCalledWith('page-1')
    expect(locking).toHaveBeenCalledTimes(1)
    r.deactivate('w')
    r.pageOpened('page-2')
    r.willLock()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(locking).toHaveBeenCalledTimes(1)
  })

  it('waits for an activate that returns a promise and keeps its Disposable', async () => {
    const r = new PluginRegistry(app, memorySettings())
    const disposed = vi.fn()
    r.activate({
      id: 'late',
      name: 'Late',
      activate: async (ctx) => {
        await Promise.resolve()
        ctx.views.register({ id: 'late.panel', title: 'Late', icon: null, order: 1, render: () => null })
        return { dispose: disposed }
      },
    })
    expect(r.views()).toEqual([])
    await r.settled()
    expect(r.views().map((v) => v.id)).toEqual(['late.panel'])
    r.deactivate('late')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(r.views()).toEqual([])
  })

  it('asks the app to show a view', () => {
    const r = new PluginRegistry(app, memorySettings())
    const shown = vi.fn()
    r.onShowView(shown)
    r.activate({ id: 's', name: 'S', activate: (ctx) => ctx.views.show('search') })
    expect(shown).toHaveBeenCalledWith('search')
  })
})

describe('matchesKeybinding', () => {
  it('needs exactly the named modifiers', () => {
    expect(matchesKeybinding('Mod+Shift+F', key('f', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(matchesKeybinding('Mod+Shift+F', key('f', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false)
    expect(matchesKeybinding('Mod+Shift+F', key('f', { metaKey: true, shiftKey: true }), false)).toBe(false)
  })
})
