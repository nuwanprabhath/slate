import type { AppApi, PluginCommand, PluginContext, PluginView, SettingsBackend, SlatePlugin } from './types'

/** Whether `e` is exactly `binding` (`Mod+Shift+F`): every named modifier held and no other. */
export function matchesKeybinding(binding: string, e: KeyboardEvent, isMac: boolean): boolean {
  const parts = binding.split('+').map((p) => p.trim().toLowerCase())
  const want = new Set(parts.slice(0, -1).map((p) => (p === 'mod' ? (isMac ? 'meta' : 'ctrl') : p)))
  return (
    e.key.toLowerCase() === parts[parts.length - 1] &&
    e.metaKey === want.has('meta') &&
    e.ctrlKey === want.has('ctrl') &&
    e.shiftKey === want.has('shift') &&
    e.altKey === want.has('alt')
  )
}

/**
 * The activated plugins' views and commands, as a small store React subscribes to. Built-ins go
 * through `activate` exactly as an external plugin would. A plugin that throws while activating
 * contributes nothing, and the others still load.
 */
export class PluginRegistry {
  private readonly viewList: PluginView[] = []
  private sorted: PluginView[] = []
  private readonly commands = new Map<string, PluginCommand>()
  private readonly listeners = new Set<() => void>()
  private readonly showListeners = new Set<(viewId: string) => void>()

  constructor(
    private readonly app: AppApi,
    private readonly settings: SettingsBackend,
  ) {}

  activate(plugin: SlatePlugin): void {
    const views: PluginView[] = []
    const commands: PluginCommand[] = []
    const prefix = `plugins.${plugin.id}.`
    const ctx: PluginContext = {
      views: { register: (v) => void views.push(v), show: (id) => this.showListeners.forEach((l) => l(id)) },
      commands: { register: (c) => void commands.push(c) },
      settings: {
        get: async <T>(key: string) => (await this.settings.get())[prefix + key] as T | undefined,
        set: async (key, value) => this.settings.set({ ...(await this.settings.get()), [prefix + key]: value }),
      },
      app: this.app,
    }
    try {
      plugin.activate(ctx)
    } catch (e) {
      console.error(`plugin ${plugin.id} failed to activate:`, e)
      return
    }
    this.viewList.push(...views)
    for (const c of commands) this.commands.set(c.id, c)
    this.sorted = [...this.viewList].sort((a, b) => a.order - b.order)
    this.listeners.forEach((l) => l())
  }

  /** Stable between changes, for useSyncExternalStore. */
  views = (): PluginView[] => this.sorted

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  onShowView(listener: (viewId: string) => void): () => void {
    this.showListeners.add(listener)
    return () => void this.showListeners.delete(listener)
  }

  runCommand(id: string): void {
    this.commands.get(id)?.run()
  }

  /** Runs the command bound to `e`, if any; true when it did, so the caller swallows the key. */
  handleKey(e: KeyboardEvent, isMac: boolean): boolean {
    for (const c of this.commands.values()) {
      if (c.keybinding && matchesKeybinding(c.keybinding, e, isMac)) {
        c.run()
        return true
      }
    }
    return false
  }

  /** The global dispatcher: capture phase, so bindings also fire inside a box editor. */
  attachKeybindings(target: Window, isMac: boolean): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.handleKey(e, isMac)) return
      e.preventDefault()
      e.stopPropagation()
    }
    target.addEventListener('keydown', onKeyDown, true)
    return () => target.removeEventListener('keydown', onKeyDown, true)
  }
}
