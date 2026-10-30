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
    r.activate({ id: 'b', name: 'B', activate: (ctx) => ctx.views.register({ id: 'b', title: 'B', icon: null, order: 20, render: () => null }) })
    r.activate({ id: 'a', name: 'A', activate: (ctx) => ctx.views.register({ id: 'a', title: 'A', icon: null, order: 10, render: () => null }) })
    expect(r.views().map((v) => v.id)).toEqual(['a', 'b'])
  })

  it('notifies subscribers when a view arrives, and keeps the same list otherwise', () => {
    const r = new PluginRegistry(app, memorySettings())
    const listener = vi.fn()
    r.subscribe(listener)
    const before = r.views()
    expect(r.views()).toBe(before)
    r.activate({ id: 'a', name: 'A', activate: (ctx) => ctx.views.register({ id: 'a', title: 'A', icon: null, order: 1, render: () => null }) })
    expect(listener).toHaveBeenCalled()
    expect(r.views()).not.toBe(before)
  })

  it('a plugin that throws contributes nothing and the others still load', () => {
    const r = new PluginRegistry(app, memorySettings())
    r.activate({ id: 'bad', name: 'Bad', activate: () => { throw new Error('boom') } })
    r.activate({ id: 'ok', name: 'Ok', activate: (ctx) => ctx.views.register({ id: 'ok', title: 'Ok', icon: null, order: 1, render: () => null }) })
    expect(r.views().map((v) => v.id)).toEqual(['ok'])
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
