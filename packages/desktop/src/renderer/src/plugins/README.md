# Activity-bar plugins

A plugin adds a button to the activity bar, a panel in the side pane, and commands. The built-in
Notebooks and Search tools are plugins, registered through the same API an external one would use
(`builtins.ts`).

```ts
const hello: SlatePlugin = {
  id: 'hello',
  name: 'Hello',
  activate(ctx) {
    ctx.views.register({ id: 'hello', title: 'Hello', icon: <HelloIcon />, order: 50, render: () => <HelloPanel ctx={ctx} /> })
    ctx.commands.register({ id: 'hello.open', title: 'Open Hello', keybinding: 'Mod+Shift+H', run: () => ctx.views.show('hello') })
  },
}
```

Add it to `builtinPlugins` and it appears on the bar, sorted by `order` (Notebooks is 0, Search 10).

## What `PluginContext` offers

- `views.register(view)`: an activity-bar button and its panel; `views.show(id)` opens a panel.
- `commands.register({ id, title, keybinding?, run })`: `Mod` is Cmd on macOS, Ctrl elsewhere.
  Bindings fire from anywhere, including inside a box editor (capture phase).
- `settings.get(key)` / `settings.set(key, value)`: persisted in the settings DB under
  `plugins.<pluginId>.<key>`. Values must be JSON.
- `app.getLibrary()`, `app.currentNotebookId()`, `app.openPage(pageId, { highlight })` (opens the
  page and its find bar pre-filled) and `app.search(query)` (the full-text index in main).

A plugin never touches `window.slate`: everything goes through the context, so a sandboxed plugin
could be handed the same interface. A plugin that throws while activating contributes nothing and
the others still load.

## Not yet

Installing plugins from disk or a marketplace, enabling or disabling them, and sandboxing are
future work. Today every plugin is built in.
