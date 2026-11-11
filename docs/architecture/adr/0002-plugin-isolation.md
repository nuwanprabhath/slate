# 0002. Whether third-party plugin code may run beside decrypted notes, and under what contract

- **Proposed:** 2026-11-12, work package A3 of the 2026-11-10 architecture review (finding F10).
- **Recommendation of this record:** **reject in-realm third-party plugins, permanently. Defer building
  the sandboxed model until there is a plugin somebody wants to install; adopt now the one rule that
  keeps it possible.** The reasoning is in "Decision".
- **Decision (maintainer, accept / reject / defer):** &nbsp;
  <!-- maintainer: write accept, reject or defer and the date on the line above. Do not fill this in for them. -->

## Context

### What exists today

Slate's activity-bar plugins are a real extension API with two built-in users: Notebooks
(`library.notebooks`) and Search (`search.panel`), registered through the same API any other plugin
would use (`packages/desktop/src/renderer/src/plugins/`). A plugin gets `views.register`,
`commands.register`, `settings.get/set`, `onPageOpened`, `onWillLock`, and an `app` facade with
`getLibrary`, `currentNotebookId`, `openPage` and `search`.

Work package A1 (merged) closed finding F10's correctness half:

- `activate` may return a `Disposable`; `views`/`commands` registrations return one;
  `PluginRegistry.deactivate(pluginId)` disposes newest-first and notifies React.
- Every view and command id must start with `<plugin.id>.`; a duplicate id or an already-held keybinding
  is refused with an error naming **both** plugins, and the offending plugin contributes nothing — a
  plugin can no longer silently replace another's command.
- `settings.set` writes are serialised through one promise chain per registry, closing the lost-update
  race.
- Every view is wrapped in an error boundary and every `run` is guarded: an activation that throws
  contributes nothing, a panel whose render throws is replaced by a "Try again" fallback, a command that
  throws is caught where it ran.

A1 deliberately did **not** add dynamic loading, and it corrected the README's false claim that a
sandboxed plugin could be handed the same interface. The README now says plainly that a plugin runs in
the app's realm beside the decrypted notes, that `PluginContext` is "a convenience and a shape, not a
security boundary", and that views are `render: () => ReactNode` — a live React node, which cannot cross
an isolation boundary. It points here for the answer. (The README's pointer currently reads
`docs/decisions/`; it should read `docs/architecture/adr/0002-plugin-isolation.md`.)

### What the question actually is

Lifecycle and namespacing are hygiene between *trusted* plugins. They are not isolation and A1 never
claimed to be. The open question is the one A1 left: **should third-party code ever run in the process
that holds the decrypted notes, and if so through what contract?**

The honest statement of the risk, given the rest of the system:

- The renderer holds decrypted note content, by design. In-realm code can read every open document, and
  nothing stops it reaching `window.slate` directly — the context object is not in its way.
- `window.slate` is the renderer's only door to disk and network (`slate/renderer-no-network`,
  `slate/renderer-no-code-eval`, the packaged CSP allowing no network), so in-realm code cannot open a
  socket of its own. That is a genuine and load-bearing limit: exfiltration would have to go through
  Slate's own API surface or an `ExternalLink`/`openExternalSafe` navigation.
- But it can read everything on screen and in the library, write settings, and act as the user. ADR
  0001's deferral means every vault key also lives in the main process, one IPC door away, with no
  process boundary between the notes and the code reading them.
- `slate/renderer-no-code-eval` and the CSP (no inline script, no remote script, `'unsafe-eval'` never
  allowed and only ever shrinking) mean a plugin cannot be *loaded* from a string or a URL today even if
  someone wanted to. Dynamic loading is not a small feature bolted onto this; it is a direct collision
  with two guardrails.

## Options considered

### A. Built-in plugins only, permanently; no third-party code, no dynamic loading

Today's position, made explicit. The API stays a way to structure Slate's own features. Zero new
surface, zero new guard work. Cost: no ecosystem, ever, and users who want one are told no.

### B. In-realm third-party plugins, trust managed by review or signing

A marketplace or a signed-manifest allowlist; code still runs in the app's realm. This is what most
Electron editors do. It is **rejected** here and the reason is not fashion: the product's promise is that
notes are encrypted at rest and the keys are destroyed at lock. Admitting unreviewed code into the realm
that holds the plaintext makes that promise depend on the review, and on a signing key, for every
extension a user installs. It also requires relaxing `renderer-no-code-eval` and the packaged CSP, both
of which are guards whose allowlists only shrink by construction.

### C. Serialisable contribution model: declarative manifest + sandboxed frame over a `MessagePort`

The shape the README names and this record is asked to specify.

- **Manifest, declarative and static.** A plugin ships JSON, not code, for everything the shell needs
  before the plugin runs: `id` (the namespace prefix A1 already enforces), `name`, `version`, the views
  it contributes (`id`, `title`, `order`, and an icon **chosen from a fixed set of names**, never SVG
  markup), the commands it contributes (`id`, `title`, `keybinding`), the lifecycle events it wants, and
  the capabilities it requests. The shell can draw the activity bar, resolve id collisions and detect
  keybinding clashes **without executing anything** — which is the real reason to make it declarative,
  beyond security.
- **The frame.** The plugin's code runs in a cross-origin, sandboxed `<iframe>` with its own CSP that
  permits no network, loaded from its own opaque origin so it shares no storage and no DOM with the app.
  It never sees `window.slate`, never sees a note document, and cannot reach the app's realm.
- **The port.** At creation the shell transfers one end of a `MessageChannel` into the frame. Every
  interaction is a structured-clone message with an explicit schema: the plugin asks, the shell decides.
  Requests are capability-checked against the manifest and rate-limited; the shell may refuse any of
  them while the vault is `locking` or locked.
- **What replaces `render: () => ReactNode`.** This is the crux and the reason the current interface
  cannot be handed over. Two viable answers, and this record recommends the first:
  1. **A serialisable view description** — a small, closed set of node types the shell renders with its
     own components (`stack`, `text`, `button`, `input`, `list`, `icon`, with ids and typed events).
     Events come back over the port. The plugin never produces DOM; the shell's look, theming, light and
     dark, and the UI audit all keep applying, which matters because `e2e/ui/audit.ts` is a guard and a
     frame full of a stranger's CSS cannot pass it. Cost: an expressiveness ceiling, and a per-interaction
     round trip.
  2. **The frame paints itself** and the shell hosts it as an opaque rectangle. Maximum expressiveness,
     but the plugin's UI is outside the UI audit, outside Slate's themes, and a visibly foreign panel.
- **Capabilities, named in the manifest and enforced at the port**, each defaulting to absent:
  `library.read` (titles and structure, never box content), `page.read.active` (the open page's text,
  which is the dangerous one and should require an explicit per-plugin grant in Settings),
  `search` (query results, not the index), `settings.own` (its own namespace only — A1 already scopes
  storage to `plugins.<pluginId>.<key>`), `command.register`, `view.contribute`, `clipboard.write`.
  There is deliberately no `network` capability and no `page.write` in the first version.
- **Lifecycle.** A1's work is the foundation and transfers directly: `deactivate(pluginId)` becomes
  "revoke the port, tear down the frame, dispose the registrations newest-first"; the error boundary
  becomes "a frame that throws, hangs or floods the port is torn down and shows the existing fallback
  panel"; `onWillLock` becomes mandatory rather than advisory — the port must be revoked and the frame
  destroyed before the vault's lock sequence closes the keys, i.e. it belongs as a step in
  `LockSteps` (`vault/lockSequence.ts`), not as a renderer convention. A1's current `onWillLock` fires on
  `pagehide` because no real vault-will-lock event exists; an isolated plugin needs the real one.

### D. Plugins in the main process / a utility process

Rejected: it puts third-party code on the side of the boundary that holds the keys, and inherits every
unresolved question in ADR 0001 besides.

## Decision

**Recommended: reject option B outright and for good. Keep option A as the shipping position. Specify
option C here and build it only when a concrete plugin needs it. Adopt one rule now.**

1. **Third-party code never runs in Slate's realm.** This is the part that should be decided now and not
   revisited per-release, because it is a property of the product's promise, not of its roadmap. If
   plugins ever ship, they ship isolated.
2. **Option C as specified is the contract**, with the serialisable view description (C.1), the
   manifest-declared capabilities, and no network capability.
3. **Do not build it yet.** There is no third-party plugin, no user asking for one, and no distribution
   story; A1's lifecycle and namespacing work was worth doing on its own merits (it fixed real races
   between the two built-in plugins) and nothing further is needed for them. Building a sandbox and a
   view protocol for a population of zero would be the largest new surface in the renderer, in the
   process that holds the plaintext, with no user on the other end of it.
4. **The rule to adopt now, which costs nothing and keeps C possible:** a new `PluginContext` member, or
   a new field on a view or command, must be expressible as a serialisable message. When something can
   only be a live object or a React node, it is a *shell* feature, not a plugin-API feature, and belongs
   outside `plugins/`. Without this rule the API drifts further from C with every convenience added, and
   C's cost grows quietly. A1's correction of the README is exactly this mistake caught once already.

**Build C when any of these happens:** someone wants to ship a plugin Slate does not own; a built-in
feature is better expressed as a manifest (an importer or an exporter is the likeliest first case, and
could be a useful trial with a first-party plugin in a real frame); or a user-scripting feature is
requested, which is option C under another name and must not be met with `eval`.

## Consequences

**If the recommendation is accepted.**

- Slate keeps saying no to plugins, and keeps a defensible reason for it: there is no isolation yet, and
  the promise about plaintext is worth more than an ecosystem.
- The README stops being an open question: it can say third-party in-realm plugins are rejected and the
  isolated model is specified-but-unbuilt, and point here.
- The serialisability rule constrains future API work slightly, and the constraint has to be remembered
  by reviewers — nothing in the guard layer checks it. Making it a lint rule (a view's `render` is the
  only live value in the plugin types; any new one needs a reason) is the obvious follow-up if the API
  grows.
- A1's `onWillLock` stays advisory, which is honest for in-realm built-ins and insufficient for C. When C
  is built, a real `vault-will-lock` event and a `LockSteps` entry are prerequisites, not details.

**If C is built.**

- A frame, a message schema, a capability check, a rate limiter, a view-description renderer, a manifest
  validator and a distribution/trust story — the largest single addition to the renderer so far, in the
  process holding plaintext. It needs a security review under `docs/review/REVIEW.md` and almost
  certainly a new guardrail row.
- The frame's CSP and the app's CSP interact; the packaging guard asserts the built app's CSP allows no
  network and only shrinks, so the frame must get its own policy without loosening the app's.
- `page.read.active` is the capability that actually hands note content to a third party. It should be a
  per-plugin, per-session, explicit grant with the plugin named, and it deserves a UI scenario of its own.
- The UI audit applies to whatever the shell draws, so C.1 keeps the audit meaningful and C.2 would
  create an un-audited rectangle. That is a second, independent reason to prefer C.1.

## Measured baseline

**Nothing about plugin isolation has been measured, and this record invents no number.** What is measured
today, and what it bounds:

- **The population.** Two plugins, both built in (`library.notebooks`, `search.panel`); zero third-party;
  no dynamic loading anywhere in the codebase (A1 report; `builtins.ts`).
- **The A1 contract, as tested.** `registry.test.ts`: **9 cases red on `main`, 16 passed after** — the
  nine being un-prefixed id, duplicate view id, duplicate command id and keybinding, `deactivate`, lone
  `dispose`, twenty concurrent `settings.set`, a throwing command, lifecycle events, and async `activate`
  (A1 report). Suite as seen on that branch: `npm test` 112 files / 868 tests, `npm run guards` 36 files
  / 712 tests, `npm run e2e -- plugins.ui.spec.ts` 1 passed with the UI audit green in dark, light, paper
  and glass at 800 and 1280 px.
- **The cost of a port round trip per plugin interaction: unmeasured.** The nearest measured figure in the
  product is a renderer↔main IPC round trip on an idle vault — 0.2 ms p50, 0.3-0.4 ms p95, with a 3.0 ms
  p95 at load 22.7 (reports D4, D4B, Apple M4, load given because the machine was shared). A
  renderer↔frame `MessagePort` hop is in-process and should be cheaper than that, but the figure is an
  expectation, not a measurement, and the relevant budget is different: a plugin panel's interaction has
  to feel immediate inside the renderer's 16 ms frame, and a view description that needs several
  round trips per keystroke in a plugin's own text field would not.
- **What to measure before building C**, each against the 16 ms frame budget: port round-trip p50/p95 for
  a trivial request; the cost of rendering a view description of 10, 100 and 1,000 nodes; the per-frame
  cost of a plugin field echoing keystrokes over the port; and frame creation and teardown time, since
  teardown sits inside the lock sequence, whose flush budget is 3,000 ms (`FLUSH_TIMEOUT_MS`).

Related, and the reason this record's recommendation is not merely cautious: ADR 0001 recommends deferring
the vault host process, so every vault key remains in the main process, one IPC door from the renderer. In
that arrangement admitting third-party code into the renderer's realm removes the last boundary around the
plaintext. If 0001 is ever accepted, that changes the calculus for this record but does not reverse it —
the notes are still decrypted in the renderer.
