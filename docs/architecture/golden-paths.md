# Golden paths

The one supported way to do each of these in Slate. Each recipe names an existing example to copy.
When a lint rule or guard test fires, its message points at one of these sections. If the path here
cannot work for your change, stop and report it as a guardrail conflict; do not route around the
check.

## Packages

Each package runs in particular processes, and the lint rules `slate/core-stays-pure`,
`slate/editor-stays-in-the-renderer`, `slate/renderer-through-bridge`,
`slate/preload-electron-and-shared`, `slate/main-never-imports-renderer` and
`slate/shared-runs-everywhere` (plus the same layers in `.dependency-cruiser.cjs`) enforce it.

| Package or folder | Runs in | May import |
| --- | --- | --- |
| `packages/core` | renderer, main, MCP, sync | `loro-crdt` only. Its tsconfig has no DOM or Node types. |
| `packages/editor` | renderer | React, TipTap, `@slate/core`. No Node types. Reaches the app through `EditorServices` (`src/services.ts`). |
| `desktop/src/renderer` | renderer (sandboxed) | `src/shared/`, `@slate/*` (types or pure code). Never `electron`, Node, `src/main`, `src/preload`. |
| `desktop/src/preload` | preload | `electron` and `src/shared/` (types from anywhere). |
| `desktop/src/shared` | all three | Nothing from Electron, Node, main, renderer or preload. |
| `desktop/src/main` | main | Anything except renderer code. |

## IPC

How to add a call from the renderer to main. `npm run new:channel -- <camelCaseName> [--policy …]`
does steps 1 and 2 and prints the rest; `npm run guards` fails until main registers the handler.
Copy `searchQuery`, which touches every file:

1. `src/shared/ipc.ts`: add the channel to `CH` (`searchQuery: 'search:query'`).
2. `src/main/ipcGuard.ts`: add its row to `CHANNEL_POLICY`. Use `unlocked` unless the lock screen
   needs it (`pre-unlock`, with a reason in review). Use `send` for a renderer → main message and
   `event` for main → renderer. The type is a `Record` over `CH`, so a missing row does not compile.
3. `src/shared/api.ts`: add the method to `SlateApi` (`search.query(q: SearchQuery)`).
4. `src/preload/index.ts`: `query: (q) => ipcRenderer.invoke(CH.searchQuery, q)`.
5. Main: handle it in a `register…Ipc(ipc, …)` function, through the registrar it is given. Take
   each argument as `unknown` and check it before acting, as `registerSearchIpc` does with
   `isSearchQuery` (`src/main/ipc.ts`); the renderer is untrusted. A new `register…Ipc` is called
   from `index.ts` with the `ipc` that `createIpc` returned.
6. Renderer: call `window.slate.search.query(…)`.
7. Test: a main-process test of the handler with a fake registrar, valid and malformed arguments (copy `src/main/ipc.test.ts`). `tools/guards/ipcChannels.test.ts` checks that
   there is exactly one `ipc.handle` for the channel.

Never import `ipcMain` (`slate/ipc-through-registrar`), and never pass a string or a variable as a
channel (`slate/ipc-channel-from-ch`).

## A renderer feature that needs main

Add the IPC call first (above), then the component in `src/renderer/src/`. The renderer never
fetches, opens sockets or windows, evaluates strings or assigns HTML (`slate/renderer-no-network`,
`slate/renderer-no-code-eval`). Copy the search plugin (`src/renderer/src/plugins/search/`), which
reaches main through `AppApi.search` and `window.slate.search.query` (`plugins/usePlugins.ts`).

## A setting

Add one entry to `SCHEMA` in `src/shared/settings/schema.ts` (default and `sanitize`) and the field
to `Settings` in `src/shared/api.ts`. Main reads it with `readSettings(store)` and writes it with
`writeSettings(store, patch)` (`src/main/settings.ts`). The renderer gets it through
`window.slate.settings`. Copy `idleMinutes`. A setting the lock screen needs is also written to the
pre-unlock file (`vault/preunlockSync.ts`).

## Vault files

Write vault files (`vault.json`, local keys, the pre-unlock file) only with `writeJsonAtomic`
(`src/main/vault/atomic.ts`), never `writeFileSync` or a plain rename (`slate/vault-writes-through-atomic`).
Read them only with `readJsonCapped(path)` from the same file, which refuses anything over 64 KiB
before `JSON.parse` (`slate/vault-json-reads-capped`, audit F-GEN-02). Copy `vault/preunlock.ts`.

## Keys and crypto

Every primitive runs in `@slate/native` (audit §4.0, C4), and JavaScript holds key handles, never key
bytes. Seal and open remote files with `sealEnvelope` / `openEnvelope` (`src/main/vault/envelope.ts`);
keys come from the `KeyRing` (`services().keyRing`) as `KeyHandle`s, never from a new derivation in a
feature. A handle from `keyRing.get(name)` belongs to the ring: use it, never destroy it. A key a vault
function makes for itself (a subkey, a KEK, a file key) is a handle it destroys in `finally` with
`destroyKey` (`src/main/vault/native.ts`), or returns with a doc comment naming the new owner. sha256 and
random bytes come from `vaultNative()` in the same file. `main/vault`, `main/sync` and `main/db` import no
`node:crypto` at all (T-STATIC-02); elsewhere it is imported only by the reviewed files in
`tools/guards/allowlists/crypto-imports.json` (`slate/crypto-stays-in-the-vault`), and no JavaScript
crypto library or deep import into the module is allowed anywhere (`slate/crypto-through-native`).
ECB only in `vault/names.ts`; no `Math.random`. An id is `newId()`; randomness (jitter, shuffles, sampling)
is `randomInt(n)` or `randomFraction()`, all in `packages/core/src/ids.ts`, the only home of the Web Crypto
global (`slate/no-web-crypto`). Never `crypto.subtle`.

## A typed password or recovery key

It is bytes from the field to the module (audit Z-5, C7). Renderer: draw the field with `<SecretField>` /
`<SecretArea>` (`src/renderer/src/vault/SecretField.tsx`), never a controlled `<input>` or React state, and
read it once at submit with `submitSecret(field, send)` or `takeSecret` + `sendSecrets`
(`vault/secretInput.ts`), which clear the field and zero the bytes when the call settles
(`slate/secrets-out-of-react-state`). The `VaultApi` method takes `SecretBytes` or `VaultSecret`
(`src/shared/secret.ts`, `tools/guards/vaultSecrets.test.ts`); the preload forwards it through `settle(…)`.
Main: register the channel in `src/main/vaultIpc.ts` as `ipc.handle(CH.x, secretHandler(…))`, which
zeroes every secret argument on every exit (`vaultIpc.test.ts`, `tools/guards/vaultSecrets.test.ts`); check
the argument with `passwordBytes(arg)` and pass the bytes down; `deriveKek` and `decodeRecovery` hand the module its own copy. Nothing in main
turns them into a string (T-STATIC-01 in `static.test.ts`); `checkPassword` (`vault/password.ts`) is the one
residual, for a password being set.

## A database table or column

Add the table to the `CREATE TABLE IF NOT EXISTS` block in the `DocStore` constructor
(`src/main/store.ts`); add a column with the `PRAGMA table_info` check below it (copy `origin`).
SQL text is a literal and values are `?` parameters (`slate/sql-text-is-literal`). An encrypted
database is opened only by `openDatabase(file, key)` (`src/main/db/openDatabase.ts`); key pragmas live
there and in `db/migrateToEncrypted.ts` (`slate/sql-key-pragma-in-db`).

## A test hook

A variable that weakens or redirects the app for tests goes in `TEST_HOOK_VARS`
(`src/main/testHooks.ts`), which a packaged app scrubs at start. Read it with `env('SLATE_…')` from
the same file, never `process.env` (`slate/env-through-test-hooks`). A variable a packaged app must
obey goes in `APP_ENV_VARS` and, with its reason, in `tools/guards/allowlists/env-vars.json`
(`tools/guards/envVars.test.ts`); a platform variable goes in `PLATFORM_ENV_VARS`. A pure function that takes an `env`
record gets `envSnapshot()` (only the documented names), never `process.env`. Copy `SLATE_TEST_IDLE_MS`.

## A dependency

Add it to the right `package.json` with an exact or caret registry version, and add a line with the
reason to `tools/guards/allowlists/dependencies.json` (`tools/guards/dependencies.test.ts`). The
maintainer approves it in review; a lockfile entry without an integrity hash or from outside the npm
registry fails the guard.

## Opening a URL

Main: `openExternalSafe(url)` (`src/main/openExternal.ts`), which allows `https:` and `mailto:` only
and opens the canonical URL it checked (`slate/open-external-safely`). A file Slate wrote:
`revealInFolder(path)` or `openLocalPath(path)` from the same module, the only importer of Electron's
`shell`. Renderer and editor: `window.slate.openExternal(url)` / `services.openExternal(url)`, which
ends in the same function; a link in JSX is `<ExternalLink href=…>` (`src/renderer/src/ExternalLink.tsx`).
The window itself never navigates or opens a page (`slate/renderer-links-through-external-link`):
main's guards (`src/main/hardening.ts`) cancel any navigation away from `app://slate/` and deny
`window.open`, handing https and mailto to `openExternalSafe`.

## A secret on this computer (a token, a credential)

`secretFile(file, secrets)` from `src/main/secretStorage.ts`, with the `SecretStorage` index.ts makes
(`appSecretStorage()`): sealed by the OS keyring through the async `safeStorage` API, never on Linux's
`basic_text` store; without a keyring the secret lasts for the session (`fips-140-3`: not at all). Tell
the user when it will not be remembered (`persistent()`). Only `secretStorage.ts` names `safeStorage`
(`slate/secrets-through-secret-storage`, `slate/no-sync-safe-storage`; `tools/guards/boundary.test.ts`).

## A custom protocol

`handleNoteProtocol(scheme, notesOpen, handler)` from `src/main/protocols.ts` for anything that serves
note data: it answers 423 while locked (`slate/protocols-through-the-gate`; `protocols.test.ts`).

## A process

`runFile(file, args)` or `spawnProgram(file, args)` from `src/main/proc.ts`: a program and an
argument array, never a shell, in the type and at run time (`slate/child-process-through-proc`,
`slate/no-shell-option`). Copy `proc.test.ts` for the test.

## A window

Call `createWindow(spec, lockScreen)` from `src/main/windows.ts`, the only `new BrowserWindow`
(`slate/windows-from-the-factory`); `loadPage` there points a window at the app or the lock screen.
Its `webPreferences` are written inline with `contextIsolation: true` and `sandbox: true`, and title-bar
options cannot override them (`slate/no-weak-web-preferences`; `windows.test.ts`; the smoke e2e spec
reads the effective preferences of every window). The window stays hidden in e2e runs. index.ts's
`openWindow` adds input tracking for the idle lock; copy how it calls `createWindow`. `createWindow`
refuses to run before `installBoundaryGuards` (`src/main/hardening.ts`), which guards every webContents
(navigation, window.open, `<webview>`) and denies permissions by default; those handlers live only there
(`slate/web-contents-guards-in-hardening`). IPC answers only Slate's own top frame (`isTrustedSender` in
`ipcGuard.ts`).

## An e2e spec

Add `packages/desktop/e2e/<name>.spec.ts` using `test` and `expect` from `./fixtures` (copy
`smoke.spec.ts`): the fixture launches the built app with `SLATE_E2E=1` (hidden window) and a
throwaway data folder. Run it with `npm run e2e -- <name>.spec.ts`; afterwards no Electron process
from the checkout may be left running.
