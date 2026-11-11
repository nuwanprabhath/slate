# Activity-bar plugins

A plugin adds a button to the activity bar, a panel in the side pane, and commands. The built-in
Notebooks and Search tools are plugins, registered through the same API any other one would use
(`builtins.ts`).

```ts
const hello: SlatePlugin = {
  id: 'hello',
  name: 'Hello',
  activate(ctx) {
    const view = ctx.views.register({ id: 'hello.panel', title: 'Hello', icon: <HelloIcon />, order: 50, render: () => <HelloPanel ctx={ctx} /> })
    const open = ctx.commands.register({ id: 'hello.open', title: 'Open Hello', keybinding: 'Mod+Shift+H', run: () => ctx.views.show('hello.panel') })
    return { dispose: () => { open.dispose(); view.dispose() } }
  },
}
```

Add it to `builtinPlugins` and it appears on the bar, sorted by `order` (Notebooks is 0, Search 10).

## What `PluginContext` offers

- `views.register(view)`: an activity-bar button and its panel; `views.show(id)` opens a panel.
- `commands.register({ id, title, keybinding?, run })`: `Mod` is Cmd on macOS, Ctrl elsewhere.
  Bindings fire from anywhere, including inside a box editor (capture phase).
- `settings.get(key)` / `settings.set(key, value)`: persisted in the settings DB under
  `plugins.<pluginId>.<key>`. Values must be JSON. Writes are queued per registry, so two `set`
  calls started together cannot lose one another.
- `onPageOpened(listener)` / `onWillLock(listener)`: lifecycle events.
- `app.getLibrary()`, `app.currentNotebookId()`, `app.openPage(pageId, { highlight })` (opens the
  page and its find bar pre-filled) and `app.search(query)` (the full-text index in main).

## Ids, lifecycle and failure

- Every view and command id must start with `<plugin.id>.`. A duplicate id, or a keybinding another
  plugin already holds, is refused with an error naming both plugins, and that plugin contributes
  nothing — it can no longer silently replace another's command.
- `views.register` and `commands.register` return a `Disposable`, and `activate` may return one (or
  a promise of one). `PluginRegistry.deactivate(pluginId)` disposes a plugin's registrations newest
  first and tells React, so a plugin can be taken away again.
- A plugin that throws is contained and reported, never fatal to the others: while activating it
  contributes nothing; a panel whose render throws is replaced by a fallback with a "Try again"
  button (`boundary.tsx`); a command that throws is caught where it ran.

## Plugins are trusted code

A plugin runs **in the app's realm, beside the decrypted notes**. It does not touch `window.slate`
directly, but `PluginContext` is a convenience and a shape, not a security boundary: nothing stops
in-realm code reaching the same globals. Today every plugin is built in, and there is no loading
from disk or a marketplace.

The contribution model would have to change before third-party code could run here: views are
`render: () => ReactNode`, a live React node, which cannot cross an isolation boundary. A
serialisable model — a declarative manifest plus a sandboxed frame talking over a `MessagePort` —
is the open question, recorded as a decision record (`docs/architecture/adr/0002-plugin-isolation.md`); it is not built, and
this README makes no claim that today's interface could be handed to a sandboxed plugin.
