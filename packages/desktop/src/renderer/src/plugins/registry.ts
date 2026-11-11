import { withErrorBoundary } from './boundary'
import type { AppApi, Disposable, PluginCommand, PluginContext, PluginErrorReporter, PluginView, SettingsBackend, SlatePlugin } from './types'

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

/** `Mod+Shift+F` and `shift+mod+f` are the same binding, so one of them is refused as a duplicate. */
function bindingKey(binding: string): string {
  const parts = binding.split('+').map((p) => p.trim().toLowerCase())
  const key = parts[parts.length - 1] ?? ''
  return [...parts.slice(0, -1).sort(), key].join('+')
}

const reportToConsole: PluginErrorReporter = (where, error) => console.error(`plugin ${where}:`, error)

/**
 * The activated plugins' views and commands, as a small store React subscribes to. Built-ins go
 * through `activate` exactly as any other plugin would.
 *
 * Every contribution is owned: `views.register` and `commands.register` hand back a `Disposable`,
 * and `deactivate(pluginId)` runs a plugin's disposables newest first, so a plugin can be taken
 * away again. Ids are namespaced (`<plugin.id>.…`) and unique, so one plugin can never shadow
 * another's command or keybinding, and a plugin that throws - while activating, while rendering a
 * view or while running a command - is contained and reported, never fatal to the others.
 */
export class PluginRegistry {
  private readonly viewList: PluginView[] = []
  private sorted: PluginView[] = []
  private readonly commands = new Map<string, PluginCommand>()
  /** View and command id -> the plugin that holds it. */
  private readonly owners = new Map<string, string>()
  private readonly keybindings = new Map<string, string>()
  private readonly registrations = new Map<string, Disposable[]>()
  private readonly listeners = new Set<() => void>()
  private readonly showListeners = new Set<(viewId: string) => void>()
  private readonly pageListeners = new Set<(pageId: string) => void>()
  private readonly lockListeners = new Set<() => void>()
  /**
   * One chain per registry for every plugin settings write. The backend replaces the whole
   * `plugins` record, so two writes started together would each read the record before the other
   * wrote it and one would be lost; queued, each reads the result of the one before it.
   */
  private writes: Promise<unknown> = Promise.resolve()
  /** The activations still running, so a test (and `deactivate`) can wait for an async `activate`. */
  private activations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly app: AppApi,
    private readonly settings: SettingsBackend,
    private readonly onError: PluginErrorReporter = reportToConsole,
  ) {}

  activate(plugin: SlatePlugin): void {
    const owned: Disposable[] = []
    this.registrations.set(plugin.id, owned)
    const ctx = this.contextFor(plugin, owned)
    let result: void | Disposable | Promise<void | Disposable>
    try {
      result = plugin.activate(ctx)
    } catch (e) {
      this.failed(plugin.id, e)
      return
    }
    if (result instanceof Promise) {
      const done = result.then(
        (d) => {
          if (this.registrations.get(plugin.id) !== owned) return d?.dispose()
          if (d) owned.push(d)
          this.notify()
        },
        (e: unknown) => this.failed(plugin.id, e),
      )
      this.activations = this.activations.then(() => done)
      return
    }
    if (result) owned.push(result)
    this.notify()
  }

  /** Resolves once every `activate` started so far has finished (an `activate` may be async). */
  async settled(): Promise<void> {
    await this.activations
  }

  /** Undoes everything the plugin registered, newest first, and tells React. */
  deactivate(pluginId: string): void {
    const owned = this.registrations.get(pluginId)
    if (!owned) return
    this.registrations.delete(pluginId)
    for (const d of [...owned].reverse()) this.guard(`${pluginId} dispose`, () => d.dispose())
    this.notify()
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

  /** The app tells the plugins a page is now open (`PluginContext.onPageOpened`). */
  pageOpened(pageId: string): void {
    for (const l of [...this.pageListeners]) this.guard('onPageOpened', () => l(pageId))
  }

  /** The app tells the plugins the vault is about to lock (`PluginContext.onWillLock`). */
  willLock(): void {
    for (const l of [...this.lockListeners]) this.guard('onWillLock', () => l())
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

  private contextFor(plugin: SlatePlugin, owned: Disposable[]): PluginContext {
    const prefix = `plugins.${plugin.id}.`
    const claim = (kind: string, id: string) => {
      if (!id.startsWith(`${plugin.id}.`)) throw new Error(`plugin "${plugin.id}": ${kind} id "${id}" must start with "${plugin.id}."`)
      const owner = this.owners.get(id)
      if (owner !== undefined) throw new Error(`plugin "${plugin.id}": ${kind} id "${id}" is already registered by plugin "${owner}"`)
      this.owners.set(id, plugin.id)
    }
    return {
      views: {
        register: (v) => {
          claim('view', v.id)
          const view = withErrorBoundary(plugin.id, v, this.onError)
          this.viewList.push(view)
          return this.own(owned, () => {
            this.owners.delete(v.id)
            const at = this.viewList.indexOf(view)
            if (at >= 0) this.viewList.splice(at, 1)
          })
        },
        show: (id) => this.showListeners.forEach((l) => l(id)),
      },
      commands: {
        register: (c) => {
          const binding = c.keybinding === undefined ? null : bindingKey(c.keybinding)
          if (binding !== null) {
            const owner = this.keybindings.get(binding)
            if (owner !== undefined) throw new Error(`plugin "${plugin.id}": keybinding "${c.keybinding ?? ''}" is already bound by plugin "${owner}"`)
          }
          claim('command', c.id)
          if (binding !== null) this.keybindings.set(binding, plugin.id)
          this.commands.set(c.id, { ...c, run: () => this.guard(`${plugin.id} command ${c.id}`, () => c.run()) })
          return this.own(owned, () => {
            this.owners.delete(c.id)
            this.commands.delete(c.id)
            if (binding !== null) this.keybindings.delete(binding)
          })
        },
      },
      settings: {
        get: async <T,>(key: string) => (await this.settings.get())[prefix + key] as T | undefined,
        set: (key, value) =>
          this.enqueue(async () => {
            const all = await this.settings.get()
            await this.settings.set({ ...all, [prefix + key]: value })
          }),
      },
      onPageOpened: (l) => this.listen(this.pageListeners, l, owned),
      onWillLock: (l) => this.listen(this.lockListeners, l, owned),
      app: this.app,
    }
  }

  private own(owned: Disposable[], undo: () => void): Disposable {
    let done = false
    const d: Disposable = {
      dispose: () => {
        if (done) return
        done = true
        undo()
        this.notify()
      },
    }
    owned.push(d)
    return d
  }

  private listen<L>(set: Set<L>, listener: L, owned: Disposable[]): Disposable {
    set.add(listener)
    return this.own(owned, () => void set.delete(listener))
  }

  /** A plugin that fails to activate leaves nothing behind: its registrations are undone. */
  private failed(pluginId: string, e: unknown): void {
    this.onError(`${pluginId} failed to activate`, e)
    this.deactivate(pluginId)
  }

  private guard(where: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.onError(where, e)
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.writes.then(op, op)
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private notify(): void {
    this.sorted = [...this.viewList].sort((a, b) => a.order - b.order)
    this.listeners.forEach((l) => l())
  }
}
