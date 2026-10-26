// @ts-check
import { allowlist } from './paths.mjs'

/**
 * One sanctioned way to do each of these things. `plugin.mjs` turns every entry into a
 * `slate/<name>` rule (the design of Apiary's eslint/sanctioned.js).
 *
 * - `files`: where the rule applies (globs from the repo root); `ignores` carves out tests.
 * - `allow`: the sanctioned homes, the only files that may do the thing directly. A file here is a
 *   design decision; reasons for a longer list live in tools/guards/allowlists/*.json, which can
 *   only shrink (tools/guards/ratchet.test.ts).
 * - `message`: what the agent reads when the rule fires. What to use instead and where it lives
 *   first, then why.
 *
 * Kinds:
 * - `import`: an import (static, dynamic or require) whose source matches `sources` or lands in one
 *   of the `into` folders; `importNames` narrows it to those names; `except`/`exceptInto` whitelist
 *   instead; `allowTypeImports` lets `import type` through.
 * - `syntax`: any node matching one of the esquery `selectors`.
 *
 * To add a rule: one entry here and its cases in sanctioned.test.ts (a real past mistake as the bad
 * case). `.claude/skills/correct/SKILL.md` walks through it.
 *
 * @typedef {{ name: string, description: string, message: string, files: readonly string[], ignores?: readonly string[], allow?: readonly string[] }} Base
 * @typedef {{ calls: RegExp, init: RegExp }} FollowConst A call whose callee name matches `calls`, with an argument that is a `const` whose initializer's text matches `init` (one step of data flow).
 * @typedef {Base & { kind: 'syntax', selectors: readonly string[], followConst?: FollowConst }} SyntaxRule
 * @typedef {Base & { kind: 'import', sources?: readonly (string | RegExp)[], into?: readonly string[], importNames?: readonly string[], except?: readonly (string | RegExp)[], exceptInto?: readonly string[], allowTypeImports?: boolean, allowNames?: Readonly<Record<string, readonly string[]>> }} ImportRule
 * @typedef {SyntaxRule | ImportRule} Sanctioned
 */

const MAIN = ['packages/desktop/src/main/**/*.ts']
/** Everything that runs in the main process: main itself and the packages it loads (red team re-run R4). */
export const MAIN_PROCESS = [...MAIN, 'packages/{sync,mcp,importer}/src/**/*.ts', 'packages/native/*.ts']
const PRELOAD = ['packages/desktop/src/preload/**/*.ts']
const RENDERER = ['packages/desktop/src/renderer/**/*.{ts,tsx}']
const SHARED = ['packages/desktop/src/shared/**/*.ts']
const EDITOR = ['packages/editor/src/**/*.{ts,tsx}']
const CORE = ['packages/core/src/**/*.ts']
const ALL_SRC = ['packages/*/src/**/*.{ts,tsx}', 'packages/native/*.ts']
const TESTS = ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'packages/*/test/**', 'packages/*/e2e/**', 'packages/*/e2e-packaged/**']

/** Electron by any entry point: `electron`, `electron/main`, `electron/common`, `electron/renderer` (red team residual). */
const ELECTRON = /^electron(\/(main|common|renderer))?$/
/** The same, for an esquery attribute selector (which cannot hold a `/`). */
const ELECTRON_SEL = '/^electron(\\x2F(main|common|renderer))?$/'
/** The vault's local files, as the constants that name them (vault/unlock.ts, quickUnlock.ts, migration.ts) or as text. */
const VAULT_FILE_NAMES =
  'Identifier[name=/^(VAULT|PENDING|PREV|LOCAL_KEYS|PREUNLOCK|REJOIN_VAULT|REJOIN_KEYS|QUICK_UNLOCK|MIGRATION)_FILE$/], ' +
  'Literal[value=/^(vault(\\.(pending|prev|rejoin))?|local-keys(\\.rejoin)?|preunlock|migration)\\.json$|^quick-unlock\\.bin$/]'

/** Node's built-in modules by their bare name, so `'fs'` is caught as well as `'node:fs'`. */
const NODE_BUILTIN = /^(node:.*|fs|fs\/promises|path|os|child_process|crypto|net|http|https|tls|dgram|dns|stream|worker_threads|vm|zlib|url|util|events|buffer|process|cluster|readline|module|v8|perf_hooks|async_hooks|inspector|tty)$/

/** TipTap/ProseMirror commands that turn text into a block format (red team final F-2). */
const BLOCK_FORMAT = '/^(setHeading|toggleHeading|setBlockquote|toggleBlockquote|toggleBulletList|toggleOrderedList|toggleTaskList|toggleList|setCodeBlock|toggleCodeBlock|wrapIn|wrapInList|toggleWrap|setNode|toggleNode)$/'
const IPC_PATH ='docs/architecture/golden-paths.md#ipc'
const BRIDGE = `the renderer reaches the disk and network only through \`window.slate\` (src/shared/api.ts); see ${IPC_PATH}.`

/** @type {readonly Sanctioned[]} */
export const SANCTIONED = [
  // ── 1. Package and process boundaries ──────────────────────────────────────────────────────────
  {
    name: 'core-stays-pure',
    kind: 'import',
    files: CORE,
    sources: ['react', 'react-dom', /^react(-dom)?\//, ELECTRON, NODE_BUILTIN, /^@slate\//, /^@tiptap\//],
    description: 'packages/core imports no React, DOM, Electron, Node or other @slate package.',
    message:
      'packages/core is pure TypeScript that the renderer, main, MCP and sync all load: no React, DOM, Electron, Node or other @slate package. ' +
      'Put platform code in the package that runs it (packages/editor for the DOM, packages/desktop/src/main for Node) and hand core plain data; see docs/architecture/golden-paths.md#packages.',
  },
  {
    name: 'editor-stays-in-the-renderer',
    kind: 'import',
    files: EDITOR,
    sources: [ELECTRON, NODE_BUILTIN, /^@slate\/desktop/],
    into: ['packages/desktop'],
    description: 'packages/editor imports no Electron, Node or desktop code.',
    message:
      'packages/editor runs in the renderer. It reaches the disk and network only through the `EditorServices` it is given (packages/editor/src/services.ts), ' +
      `which the desktop app fills from \`window.slate\`; ${BRIDGE}`,
  },
  {
    name: 'renderer-through-bridge',
    kind: 'import',
    files: RENDERER,
    sources: [ELECTRON, NODE_BUILTIN],
    into: ['packages/desktop/src/main', 'packages/desktop/src/preload'],
    allowTypeImports: false,
    description: 'The renderer imports no Electron, Node, main or preload code.',
    message: `No Electron, Node, src/main or src/preload in the renderer (types come from src/shared/): ${BRIDGE}`,
  },
  {
    name: 'preload-electron-and-shared',
    kind: 'import',
    files: PRELOAD,
    sources: [/.*/],
    except: ['electron'],
    exceptInto: ['packages/desktop/src/shared'],
    allowTypeImports: true,
    description: 'The preload imports electron and src/shared/ only.',
    message:
      'The preload exposes `window.slate` and nothing else, so it imports `electron` (contextBridge, ipcRenderer) and src/shared/ only (types from anywhere). ' +
      `Declare the call in src/shared/api.ts and src/shared/ipc.ts and do the work in main; see ${IPC_PATH}.`,
  },
  {
    name: 'main-never-imports-renderer',
    kind: 'import',
    files: MAIN,
    into: ['packages/desktop/src/renderer'],
    description: 'Main never imports renderer code.',
    message: 'The main process must not import renderer code. Move what both sides need to src/shared/ (no Electron, no Node there).',
  },
  {
    name: 'shared-runs-everywhere',
    kind: 'import',
    files: SHARED,
    sources: [ELECTRON, NODE_BUILTIN],
    into: ['packages/desktop/src/main', 'packages/desktop/src/renderer', 'packages/desktop/src/preload'],
    allowTypeImports: true,
    description: 'src/shared imports no Electron, Node, main, renderer or preload code.',
    message:
      'src/shared/ is loaded by main, the preload and the renderer, so it may use none of their powers: no Electron, no Node, no imports from main/renderer/preload. ' +
      'Keep the platform part on its side and pass plain data in.',
  },

  // ── 2. Renderer: no network, no code from strings ──────────────────────────────────────────────
  {
    name: 'renderer-no-network',
    kind: 'syntax',
    files: [...RENDERER, ...EDITOR],
    ignores: TESTS,
    selectors: [
      // Any reference, not only a call: an alias (`const f = fetch`) is the same door.
      'Identifier[name=/^(fetch|XMLHttpRequest|WebSocket|EventSource)$/]:not(Property > Identifier.key):not(MemberExpression > Identifier.property)',
      'VariableDeclarator[init.name=/^(window|globalThis|self)$/] > ObjectPattern > Property[key.name=/^(fetch|XMLHttpRequest|WebSocket|EventSource|open)$/]',
      'MemberExpression[object.name=/^(window|globalThis|self)$/][property.name=/^(fetch|XMLHttpRequest|WebSocket|EventSource|open)$/]',
      'MemberExpression[computed=true][property.value=/^(fetch|XMLHttpRequest|WebSocket|EventSource|open|sendBeacon)$/]',
      "MemberExpression[object.name='navigator'][property.name='sendBeacon']",
    ],
    description: 'The renderer opens no network connection and no window of its own.',
    message: `No fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon or window.open in renderer code, by any name: ${BRIDGE} Links open through \`window.slate.openExternal\`.`,
  },
  {
    name: 'renderer-no-code-eval',
    kind: 'syntax',
    files: [...RENDERER, ...EDITOR],
    ignores: TESTS,
    selectors: [
      "CallExpression[callee.name='eval']",
      "NewExpression[callee.name='Function']",
      "CallExpression[callee.name='Function']",
      "CallExpression[callee.name=/^(setTimeout|setInterval)$/] > :matches(Literal, TemplateLiteral).arguments:first-child",
      "CallExpression[callee.property.name=/^(setTimeout|setInterval)$/] > :matches(Literal, TemplateLiteral).arguments:first-child",
      "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
      "CallExpression[callee.property.name='insertAdjacentHTML']",
      "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
      "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      // Red team R2: markup sinks by other names, and adopting nodes another document parsed.
      "CallExpression[callee.property.name=/^(createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|adoptNode|importNode)$/]",
      "CallExpression[callee.object.name='Object'][callee.property.name='assign'] Property[key.name=/^(innerHTML|outerHTML|srcdoc)$/]",
      "JSXAttribute[name.name='srcDoc']",
    ],
    description: 'The renderer never turns a string into code or markup.',
    message:
      'Clear a node with `el.replaceChildren()`; build DOM with React, or document.createElement and textContent. Untrusted HTML goes through the paste sanitiser (`cleanHtml` in packages/editor/src/clipboard.ts), which walks the parsed document and builds new nodes; never insert, adopt or import its nodes. ' +
      'eval, new Function, string timers and HTML strings are how a pasted note becomes script in the window that holds the vault IPC.',
  },
  {
    name: 'parse-html-in-the-sanitiser',
    kind: 'syntax',
    files: [...RENDERER, ...EDITOR],
    ignores: TESTS,
    selectors: ["CallExpression[callee.property.name='parseFromString']", "NewExpression[callee.name='DOMParser']", "CallExpression[callee.property.name='createHTMLDocument']"],
    allow: ['packages/editor/src/clipboard.ts'],
    description: 'HTML is parsed only by the paste sanitiser, packages/editor/src/clipboard.ts.',
    message:
      'Pass untrusted HTML to the paste sanitiser (`cleanHtml` in packages/editor/src/clipboard.ts): it parses into a detached document, walks it and builds new nodes. ' +
      'A second parser invites inserting the parsed nodes, whose inline handlers then run beside `window.slate` (red team R2).',
  },
  {
    name: 'secrets-out-of-react-state',
    kind: 'syntax',
    files: RENDERER,
    ignores: TESTS,
    selectors: [
      // A typed secret held in React state: `const [password, setPassword] = useState('')` (the pre-C7 lock screen).
      "VariableDeclarator[init.callee.name=/^use(State|Reducer)$/] > ArrayPattern > Identifier:first-child[name=/(password|passphrase|secret)$/i]",
      "VariableDeclarator[init.callee.property.name=/^use(State|Reducer)$/] > ArrayPattern > Identifier:first-child[name=/(password|passphrase|secret)$/i]",
      // A password field drawn by hand, controlled or not: `<input type="password" value={pw} …>`.
      "JSXOpeningElement[name.name=/^(input|textarea)$/]:has(JSXAttribute[name.name='type'] Literal[value='password'])",
      // A recovery-key or password field drawn by hand as plain text (the pre-C7 wizard's `<textarea value={typed}>`).
      "JSXOpeningElement[name.name=/^(input|textarea)$/]:has(JSXAttribute[name.name=/^(data-testid|placeholder|aria-label|name|autoComplete)$/] Literal[value=/password|recovery|secret/i])",
    ],
    allow: [
      'packages/desktop/src/renderer/src/vault/SecretField.tsx',
      // The git personal access token field only: a sync credential, not a vault secret. SyncConfig carries it as a
      // string to main, which seals it with safeStorage's string API (B-5); moving it to bytes is outside C7.
      'packages/desktop/src/renderer/src/sync/SyncTokenField.tsx',
    ],
    description: 'A typed password or recovery key is never kept in React state; it is drawn by SecretField and read once at submit.',
    message:
      'Draw the field with `<SecretField>`/`<SecretArea>` (src/renderer/src/vault/SecretField.tsx) and read it at submit with `submitSecret`/`takeSecret` (vault/secretInput.ts): the field is cleared, the bytes go to main and are zeroed when the call settles. ' +
      'React state keeps copies of a string for as long as the page lives, and every render makes more (audit Z-5, listing B.19; C7).',
  },
  {
    name: 'sync-token-field-in-sync-settings',
    kind: 'import',
    files: RENDERER,
    ignores: TESTS,
    sources: [/(^|\/)SyncTokenField(\.tsx)?$/],
    allow: ['packages/desktop/src/renderer/src/sync/SyncSettings.tsx'],
    description: 'SyncTokenField (a controlled password input exempt from secrets-out-of-react-state) is used only by the sync settings.',
    message:
      'Use `<SecretField>` (src/renderer/src/vault/SecretField.tsx) for a password or recovery key, read once at submit with `submitSecret`. ' +
      'SyncTokenField holds its text in React state; it is exempt only for the git token in sync/SyncSettings.tsx (audit Z-5; review C7 L3).',
  },
  {
    name: 'renderer-links-through-external-link',
    kind: 'syntax',
    files: [...RENDERER, ...EDITOR],
    ignores: TESTS,
    selectors: [
      "JSXOpeningElement[name.name='a'] > JSXAttribute[name.name='href']",
      "JSXAttribute[name.name=/^(target|formAction|action)$/]",
      "JSXOpeningElement[name.name=/^(iframe|webview|embed|object|frame|portal)$/]",
      "AssignmentExpression > MemberExpression.left[object.name='location']",
      "AssignmentExpression > MemberExpression.left[property.name='location']",
      "AssignmentExpression > MemberExpression.left[object.property.name='location']",
      "CallExpression > MemberExpression.callee[object.name='location'][property.name=/^(assign|replace)$/]",
      "CallExpression > MemberExpression.callee[object.property.name='location'][property.name=/^(assign|replace)$/]",
      "MemberExpression[property.name='open'][object.property.name=/^(defaultView|opener|parent|top)$/]",
      "MemberExpression[property.name='open'][object.expression.property.name=/^(defaultView|opener|parent|top)$/]",
      // Review L: a link or form built by hand (`createElement('a')`, `.href = u`, `.click()`).
      "CallExpression[callee.property.name='createElement'] > Literal.arguments:first-child[value=/^(a|area|form|iframe|frame|embed|object)$/i]",
      "AssignmentExpression > MemberExpression.left[property.name=/^(href|target|action|formAction)$/]:not([object.name='location']):not([object.property.name='location'])",
      // A bare `open(url)` is not matched: local functions named `open` are common (searchPlugin.tsx);
      // main's setWindowOpenHandler denies it at run time.
    ],
    allow: ['packages/desktop/src/renderer/src/ExternalLink.tsx'],
    description: 'Links and navigation in the renderer go through ExternalLink / window.slate.openExternal.',
    message:
      'Render a link with `<ExternalLink href=…>` (src/renderer/src/ExternalLink.tsx), or call `window.slate.openExternal(url)` (editor: `services.openExternal`): main opens https and mailto in the browser. ' +
      'The window never navigates or opens a page: a remote page in a Slate window would get the preload and the vault IPC (audit B-1, red team R1).',
  },

  {
    name: 'editor-rules-from-spec',
    kind: 'syntax',
    files: [...EDITOR, ...RENDERER],
    ignores: TESTS,
    selectors: ['Property[key.name=/^(enableInputRules|enablePasteRules)$/]'],
    allow: ['packages/editor/src/inputRules.ts'],
    description: 'Input and paste rules come from editorRuleOptions only.',
    message:
      'Spread `editorRuleOptions(services)` (packages/editor/src/inputRules.ts) into the editor options. That function is the product rule "no auto-formatting by default", pinned by the guarded spec packages/editor/test/spec/inputRules.test.ts; changing it needs the maintainer.',
  },

  {
    name: 'block-format-from-commands',
    kind: 'syntax',
    files: [...EDITOR, ...RENDERER],
    ignores: TESTS,
    selectors: [
      `CallExpression[callee.property.name=${BLOCK_FORMAT}]`,
      `CallExpression[callee.property.value=${BLOCK_FORMAT}]`,
      "Property[key.name=/^(handleTextInput|appendTransaction)$/]",
      "MethodDefinition[key.name=/^(handleTextInput|appendTransaction)$/]",
      "CallExpression[callee.name='inputRules']",
      "ImportDeclaration[source.value=/^(prosemirror-inputrules|@tiptap\\/pm\\/inputrules|@tiptap\\/extension-typography)$/]",
    ],
    // The toolbar is the explicit command surface; extensions.ts holds AutoBullets, the one spec'd exception.
    allow: ['packages/desktop/src/renderer/src/Toolbar.tsx', 'packages/editor/src/extensions.ts'],
    description: 'Block formatting only from explicit commands; nothing rewrites typing.',
    message:
      'Lists, headings, quotes and code blocks come only from an explicit command (the toolbar, packages/desktop/src/renderer/src/Toolbar.tsx); a keymap, handleTextInput, appendTransaction or input-rule plugin that formats as you type breaks the product rule "no auto-formatting by default" (CLAUDE.md), pinned by packages/editor/test/spec/inputRules.test.ts. Changing it needs the maintainer.',
  },
  {
    name: 'key-bytes-in-the-vault',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ["CallExpression[callee.name='vaultKeyBuffer']", "CallExpression[callee.property.name='vaultKeyBuffer']"],
    allow: ['packages/desktop/src/main/vault/**', 'packages/desktop/src/main/db/**'],
    description: 'KeyRing keys are unwrapped to a Buffer only in main/vault and main/db.',
    message:
      'A KeyRing key is `KeyBytes`, opaque on purpose (red team G2-5): borrow its bytes for one call with `withKeyBytes(key, (bytes) => …)` and zero it with `zeroKey(key)` (src/main/vault/keyring.ts). `vaultKeyBuffer` is for main/vault and main/db only, until keys move behind native handles.',
  },
  {
    name: 'no-key-bytes-cast',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: [
      "TSAsExpression[expression.type='TSAsExpression'][typeAnnotation.typeName.name=/^(Buffer|Uint8Array|ArrayBuffer|KeyBytes)$/]",
      "TSTypeAssertion[expression.type=/^TS(AsExpression|TypeAssertion)$/][typeAnnotation.typeName.name=/^(Buffer|Uint8Array|ArrayBuffer|KeyBytes)$/]",
    ],
    allow: ['packages/desktop/src/main/vault/keyring.ts'],
    description: 'Only keyring.ts casts through `unknown` to bytes or to KeyBytes.',
    message:
      'A double cast to Buffer, Uint8Array, ArrayBuffer or KeyBytes would unwrap an opaque KeyRing key (red team G2-5). Use `withKeyBytes(key, (bytes) => …)` from src/main/vault/keyring.ts, or give the value its real type.',
  },

  // ── 3. IPC has one door ────────────────────────────────────────────────────────────────────────
  {
    name: 'ipc-through-registrar',
    kind: 'syntax',
    files: MAIN,
    selectors: [
      `ImportDeclaration[source.value=${ELECTRON_SEL}] > ImportSpecifier[imported.name=/^(ipcMain|MessageChannelMain)$/]`,
      "MemberExpression[property.name=/^(ipcMain|MessageChannelMain)$/]",
      // webContents.ipc and a sender's own ipc: a per-window ipcMain beside the registrar.
      "MemberExpression[property.name='ipc'][object.type='MemberExpression'][object.property.name='webContents']",
      "MemberExpression[property.name='ipc'][object.name=/^(webContents|wc|contents|sender|win)$/]",
    ],
    allow: ['packages/desktop/src/main/ipcGuard.ts'],
    description: 'Only ipcGuard.ts touches ipcMain (or webContents.ipc, MessageChannelMain).',
    message:
      'Register handlers on the `IpcRegistrar` that `createIpc` (src/main/ipcGuard.ts) returns: take it as the first parameter of your `register…Ipc(ipc, …)` and call it from index.ts. ' +
      `ipcMain, webContents.ipc and MessageChannelMain skip the vault gate (CHANNEL_POLICY) and the rejection log. Steps: ${IPC_PATH}.`,
  },
  {
    name: 'ipc-registrar-once',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: ["CallExpression[callee.name=/^(createIpc|guardHandlers)$/]", "CallExpression[callee.property.name=/^(createIpc|guardHandlers)$/]"],
    allow: ['packages/desktop/src/main/index.ts', 'packages/desktop/src/main/ipcGuard.ts'],
    description: 'createIpc is called once, in index.ts.',
    message: `Take the \`IpcRegistrar\` as a parameter (\`register…Ipc(ipc, …)\`); index.ts builds the one registrar with \`createIpc\`. A second registrar could carry an always-open gate. Steps: ${IPC_PATH}.`,
  },
  {
    name: 'preload-exposes-only-slate',
    kind: 'syntax',
    files: PRELOAD,
    ignores: TESTS,
    selectors: [
      "Identifier[name='ipcRenderer']:not(MemberExpression > Identifier.object):not(ImportSpecifier > Identifier)",
      "CallExpression[callee.property.name='exposeInMainWorld']:not([arguments.0.value='slate'])",
    ],
    description: 'The preload exposes window.slate only, and never ipcRenderer itself.',
    message:
      'Expose one method per call on `window.slate` (src/shared/api.ts), each calling `ipcRenderer.invoke/send/on(CH.<name>, …)` directly. ' +
      `Passing ipcRenderer on, aliasing it, or a generic invoke(channel) gives the renderer every channel at once. Steps: ${IPC_PATH}.`,
  },

  // ── 5. Crypto stays in the vault ───────────────────────────────────────────────────────────────
  {
    name: 'crypto-stays-in-the-vault',
    kind: 'import',
    files: ALL_SRC,
    ignores: TESTS,
    sources: ['node:crypto', 'crypto'],
    allowNames: Object.fromEntries(Object.entries(allowlist('crypto-imports')).map(([file, entry]) => [file, /** @type {{ names: string[] }} */ (entry).names])),
    description: 'node:crypto only in the reviewed files of tools/guards/allowlists/crypto-imports.json, and never in main/vault, main/sync or main/db (T-STATIC-02).',
    message:
      'Cryptography runs in @slate/native, through the vault: `sealEnvelope`/`openEnvelope` (src/main/vault/envelope.ts), the `KeyRing`\'s handles, and `vaultNative()` (src/main/vault/native.ts) for sha256 and random bytes; `newId()` from packages/core/src/ids.ts for an id. ' +
      'main/vault, main/sync and main/db import no node:crypto at all (audit §4.0 invariant 1, T-STATIC-02); elsewhere each file is a reviewed entry in tools/guards/allowlists/crypto-imports.json naming the imports it may use. See docs/architecture/golden-paths.md#keys-and-crypto.',
  },
  {
    name: 'no-get-builtin-module',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: [
      "CallExpression[callee.property.name='getBuiltinModule']",
      "MemberExpression[property.name='getBuiltinModule']:not(CallExpression > MemberExpression.callee)",
      // Re-review L3-R: process['getBuiltinModule'] and const { getBuiltinModule } = process.
      "MemberExpression[computed=true][property.value='getBuiltinModule']",
      "ObjectPattern > Property[key.name='getBuiltinModule']",
    ],
    description: 'No process.getBuiltinModule: a builtin by name passes every import check (review C4 L3).',
    message:
      'Import the module with a static `import` so the lint rules and the bundler see it. `process.getBuiltinModule(name)` loads node:crypto, child_process or fs past crypto-stays-in-the-vault, child-process-through-proc and every other import rule.',
  },
  {
    name: 'crypto-through-native',
    kind: 'import',
    files: ALL_SRC,
    ignores: [...TESTS, 'packages/native/**'],
    sources: [
      /^(hash-wasm|argon2|argon2-browser|bcrypt|bcryptjs|scrypt-js|crypto-js|node-forge|tweetnacl|tweetnacl-util|libsodium(-wrappers)?(-sumo)?|sodium-native|sjcl|jssha|js-sha\d+|asmcrypto\.js|elliptic|secp256k1|openpgp)(\/.*)?$/,
      /^@(noble|scure|stablelib)\//,
      /^@slate\/native\/./,
      /\.node$/,
    ],
    description: 'Cryptographic primitives only through @slate/native\'s index (audit C4): no JavaScript crypto library, no deep import into the module, no .node binary.',
    message:
      'Cryptography runs in @slate/native (OpenSSL with the FIPS provider; Argon2id and suite 0x01 in its standard context). Import `@slate/native` (its index) and reach it through src/main/vault (native.ts, envelope.ts, header.ts, keyring.ts), which hold key handles, never key bytes. ' +
      'A JavaScript crypto library is a second, unvalidated stack whose keys live in the JS heap (audit F-FIPS-01, Z-7); hash-wasm stays a devDependency for the T-KAT-02 cross-check only. See docs/architecture/golden-paths.md#keys-and-crypto.',
  },
  {
    name: 'no-web-crypto',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: [
      "Identifier[name='crypto']:not(Property > Identifier.key):not(MemberExpression > Identifier.property):not(ImportSpecifier > Identifier)",
      "MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.name='crypto']",
      "MemberExpression[property.name=/^(subtle|webcrypto)$/]",
      "ImportSpecifier[imported.name='webcrypto']",
    ],
    allow: ['packages/core/src/ids.ts'],
    description: 'The Web Crypto global only in packages/core/src/ids.ts.',
    message:
      'For an id use `newId()`, for randomness `randomInt(n)` or `randomFraction()` (packages/core/src/ids.ts, the one home of the Web Crypto global); to seal data use `sealEnvelope` (src/main/vault/envelope.ts), which runs in @slate/native. ' +
      'crypto.subtle is a second, unreviewed crypto stack: its modes (CBC with a fixed IV, raw keys in JS) bypass the vault and the native boundary (audit §4.0).',
  },
  {
    name: 'no-create-require',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ["ImportSpecifier[imported.name='createRequire']", "MemberExpression[property.name='createRequire']"],
    // The one native addon is a .node binary, which only require can load; its path is fixed at build time.
    allow: ['packages/native/index.ts'],
    description: 'No createRequire in source.',
    message: 'Import modules with a static `import` so the lint rules and the bundler see them. createRequire with a computed name hides an import (node:crypto, child_process) from every guard.',
  },
  {
    name: 'legacy-crypto-in-v1-path',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: [...TESTS, 'packages/native/**'],
    selectors: [
      "MemberExpression[property.name=/^(hkdfLegacy|hkdfFromSecret|hkdfFromRecovery|aesEcbBlock)$/]",
      "MemberExpression[computed=true][property.value=/^(hkdfLegacy|hkdfFromSecret|hkdfFromRecovery|aesEcbBlock)$/]",
      "VariableDeclarator > ObjectPattern > Property[key.name=/^(hkdfLegacy|hkdfFromSecret|hkdfFromRecovery|aesEcbBlock)$/]",
    ],
    allow: ['packages/desktop/src/main/vault/suite1.ts'],
    description: 'The module suite-0x01 primitives (RFC 5869 HKDF from a key or a secret, AES-ECB) only in vault/suite1.ts, the v1 read path (C5).',
    message:
      'Suite 0x01 is read-only legacy (audit §4.5.1): header-v1 vaults keep it until C9, and a fips-140-3 vault never reaches it (C5 criterion 2). New code derives with `kbkdf`/`kbkdfFromSecret` (suite 0x02, SP 800-108r1) and names with `encodeIdV2` (vault/names.ts); a v1 vault goes through the functions in vault/suite1.ts. See docs/architecture/golden-paths.md#keys-and-crypto.',
  },
  {
    name: 'suite1-from-the-dispatch-sites',
    kind: 'import',
    files: MAIN,
    ignores: TESTS,
    sources: [/(^\.\/|\/vault\/)suite1(\.[cm]?[jt]s)?$/],
    allow: [
      'packages/desktop/src/main/vault/keyring.ts',
      'packages/desktop/src/main/vault/envelope.ts',
      'packages/desktop/src/main/vault/names.ts',
      'packages/desktop/src/main/vault/header.ts',
      'packages/desktop/src/main/vault/quickUnlock.ts',
    ],
    description: 'vault/suite1.ts (the v1 read path) only from the five files that dispatch on a header-v1 vault (review C5 L2).',
    message:
      'Suite 0x01 is reached only where a header-v1 vault is told apart from a header-v2 one: the key schedule (keyring.ts), the envelope, the names, the header and quick unlock. Pass the vault\'s `KeySchedule` (vault/suite.ts) and let `deriveSubkey`, `sealEnvelope` or `encodeIdV2` choose; a new caller of the v1 wrappers would let a suite-0x02 vault run RFC 5869 HKDF or AES-ECB.',
  },
  {
    name: 'argon2-in-kdf',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: [...TESTS, 'packages/native/**'],
    selectors: [
      "MemberExpression[property.name=/^(argon2id|argon2idAsync)$/]",
      "MemberExpression[computed=true][property.value=/^(argon2id|argon2idAsync)$/]",
      "VariableDeclarator > ObjectPattern > Property[key.name=/^(argon2id|argon2idAsync)$/]",
    ],
    allow: ['packages/desktop/src/main/vault/kdf.ts'],
    description: 'Argon2id (non-approved, the standard profile only) only in vault/kdf.ts (C5).',
    message:
      'Derive a password KEK with `deriveKek` (vault/kdf.ts), which picks the profile\'s KDF from the header: Argon2id for standard, PBKDF2-HMAC-SHA-512 for fips-140-3. Argon2id is not an approved function (IG 2.4.A), so it must never run for a fips-140-3 vault (C5 criterion 2); one call site keeps that checkable.',
  },
  {
    name: 'no-ecb',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ['Literal[value=/(^|[-_])ecb$/i]', 'TemplateElement[value.raw=/(^|[-_])ecb$/i]'],
    allow: ['packages/desktop/src/main/vault/names.ts'],
    description: 'AES-ECB only in vault/names.ts (suite 0x01 remote names).',
    message:
      'Use `sealEnvelope`/`openEnvelope` (src/main/vault/envelope.ts, AES-256-GCM in @slate/native). ECB leaks equal blocks; its one reviewed use is the deterministic remote names in vault/names.ts, which audit §4.6 replaces (C5).',
  },
  {
    name: 'no-math-random',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ["MemberExpression[object.name='Math'][property.name='random']", "MemberExpression[object.name='Math'][computed=true]"],
    description: 'No Math.random in source.',
    message:
      'Use `randomInt(n)` or `randomFraction()` for jitter, shuffles and sampling, and `newId()` for an id (all in packages/core/src/ids.ts, backed by crypto.getRandomValues). Math.random is predictable, and a predictable id or nonce is a security bug waiting for a caller.',
  },

  // ── 6. Electron windows and URLs ───────────────────────────────────────────────────────────────
  {
    name: 'no-weak-web-preferences',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: [
      'Property[key.name=/^(nodeIntegration|nodeIntegrationInWorker|nodeIntegrationInSubFrames|allowRunningInsecureContent|experimentalFeatures|webviewTag)$/]:not([value.value=false])',
      'Property[key.name=/^(contextIsolation|sandbox|webSecurity)$/]:not([value.value=true])',
      "ObjectExpression > Property[key.name='webPreferences']:not([value.type='ObjectExpression'])",
      "Property[key.name='webPreferences'] > ObjectExpression > SpreadElement",
    ],
    description: 'webPreferences keep isolation, sandbox and web security on, written inline.',
    message:
      'Write `webPreferences` inline in `createWindow` (src/main/windows.ts), with `contextIsolation: true`, `sandbox: true` and `webSecurity` left out or `true`, as literals, ' +
      'and nodeIntegration, allowRunningInsecureContent, experimentalFeatures and webviewTag left out. The renderer shows untrusted note content; no setting, variable or spread may give it Node or a weaker sandbox (audit B-1).',
  },
  {
    name: 'windows-from-the-factory',
    kind: 'syntax',
    files: MAIN,
    selectors: [
      "NewExpression[callee.name=/^(BrowserWindow|BrowserView|WebContentsView)$/]",
      // Review L: `import * as e from 'electron'; new e.BrowserWindow()`.
      "NewExpression[callee.property.name=/^(BrowserWindow|BrowserView|WebContentsView)$/]",
      "MemberExpression[object.name='webContents'][property.name='create']",
    ],
    allow: ['packages/desktop/src/main/windows.ts'],
    description: 'new BrowserWindow (or a view) only in the window factory.',
    message:
      'Open windows with `createWindow` (src/main/windows.ts): it sets the preload, the sandbox, context isolation and the hidden-in-e2e rule every window needs, and refuses to run before the navigation and permission guards (src/main/hardening.ts). See docs/architecture/golden-paths.md#a-window.',
  },
  {
    name: 'loads-in-the-factory',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: ["CallExpression[callee.property.name=/^(loadURL|loadFile)$/]"],
    allow: ['packages/desktop/src/main/windows.ts', 'packages/desktop/src/main/hardening.ts'],
    description: 'Pages load only through loadPage (windows.ts) and the guards (hardening.ts).',
    message:
      'Point a window at Slate with `loadPage(win, lockScreen)` (src/main/windows.ts). A load main starts skips will-navigate, so a stray `loadURL` could put a remote page, with the preload, in a Slate window (review of C8).',
  },
  {
    name: 'web-contents-guards-in-hardening',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: [
      "CallExpression[callee.property.name=/^(setWindowOpenHandler|setPermissionRequestHandler|setPermissionCheckHandler|setDevicePermissionHandler|setDisplayMediaRequestHandler)$/]",
      "CallExpression[callee.property.name=/^(on|once|addListener|prependListener|prependOnceListener|off|removeListener|removeAllListeners)$/] > Literal.arguments:first-child[value=/^(will-navigate|will-redirect|will-frame-navigate|will-attach-webview|web-contents-created|did-navigate|did-fail-load)$/]",
      // Review L: the same names as a template literal, and removeAllListeners() with no name, which strips every guard.
      "CallExpression[callee.property.name=/^(on|once|addListener|prependListener|prependOnceListener|off|removeListener|removeAllListeners)$/] > TemplateLiteral.arguments:first-child > TemplateElement[value.raw=/(will-navigate|will-redirect|will-frame-navigate|will-attach-webview|web-contents-created|did-navigate|did-fail-load)/]",
      "CallExpression[callee.property.name='removeAllListeners'][arguments.length=0]",
    ],
    allow: ['packages/desktop/src/main/hardening.ts'],
    description: 'Navigation, window-open and permission handlers only in hardening.ts.',
    message:
      'Every webContents gets its guards from `installBoundaryGuards` (src/main/hardening.ts): navigation stays on app://slate/, window.open is denied (links go to `openExternalSafe`), permissions are denied by default. ' +
      'A second handler elsewhere could allow what those deny; change the policy in hardening.ts, with a test (audit B-1, B-3).',
  },
  {
    name: 'protocols-through-the-gate',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: [
      "MemberExpression[object.name='protocol'][property.name=/^(handle|unhandle)$/]",
      "MemberExpression[property.name='handle'][object.property.name='protocol']",
      "MemberExpression[property.name=/^(register|intercept)(File|Buffer|String|Http|Stream)Protocol$/]",
    ],
    allow: ['packages/desktop/src/main/protocols.ts'],
    description: 'Custom protocol handlers only through src/main/protocols.ts.',
    message:
      'Serve note data with `handleNoteProtocol(scheme, notesOpen, handler)` (src/main/protocols.ts), which answers 423 while the vault is locked; the renderer\'s own files go through `handleAppProtocol`. ' +
      'A protocol handler is a door to the data beside IPC, and it must be gated like IPC.',
  },
  {
    name: 'open-external-safely',
    kind: 'syntax',
    files: MAIN,
    selectors: [
      `ImportDeclaration[source.value=${ELECTRON_SEL}] > ImportSpecifier[imported.name='shell']`,
      "MemberExpression[object.name='electron'][property.name='shell']",
    ],
    allow: ['packages/desktop/src/main/openExternal.ts'],
    description: 'Electron\'s shell is imported only by openExternal.ts.',
    message:
      'Use `openExternalSafe(url)` for a URL, `revealInFolder(path)` or `openLocalPath(path)` for a file Slate wrote (all in src/main/openExternal.ts, the only importer of `shell`). ' +
      'A URL or path from a note is untrusted, and shell.openExternal or openPath with file:, smb: or an app scheme can launch a program.',
  },

  // ── 7. Processes and TLS ───────────────────────────────────────────────────────────────────────
  {
    name: 'child-process-through-proc',
    kind: 'import',
    files: ALL_SRC,
    ignores: TESTS,
    sources: ['node:child_process', 'child_process'],
    allow: ['packages/desktop/src/main/proc.ts', ...Object.keys(allowlist('process-imports'))],
    description: 'Programs start through src/main/proc.ts.',
    message:
      'Start programs with `runFile(file, args)` or `spawnProgram(file, args)` from src/main/proc.ts: an argument array and never a shell, enforced in the type and at run time. ' +
      'The files that still import node:child_process are reviewed entries in tools/guards/allowlists/process-imports.json.',
  },
  {
    name: 'no-shell-exec',
    kind: 'import',
    files: [...ALL_SRC, 'scripts/**', 'tools/**', 'bin/**'],
    sources: ['node:child_process', 'child_process'],
    importNames: ['exec', 'execSync'],
    description: 'No child_process.exec / execSync.',
    message:
      'Use `execFile` or `spawn` with an argument array (src/main/update/electronBackend.ts and packages/sync/src/gitRunner.ts do). exec runs a shell, so any path or name in the command line becomes shell syntax.',
  },
  {
    name: 'no-shell-option',
    kind: 'syntax',
    files: [...ALL_SRC, 'scripts/**', 'tools/**', 'bin/**'],
    ignores: TESTS,
    selectors: [
      "ObjectExpression > Property[key.name='shell'][shorthand=false]:not([value.value=false]):not([value.type='ObjectExpression'])",
      "CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)$/] Property[computed=true]",
      "CallExpression[callee.property.name=/^(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)$/] Property[computed=true]",
      "CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)$/] Property[key.name='shell'][shorthand=true]",
      "CallExpression[callee.property.name=/^(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)$/] Property[key.name='shell'][shorthand=true]",
      // A shell program named as the file to run (proc.ts also refuses one given -c at run time).
      'CallExpression[callee.name=/^(runFile|spawnProgram|spawn|spawnSync|execFile|execFileSync)$/] > Literal.arguments:first-child[value=/(^|[\\\\/])(sh|bash|zsh|dash|ksh|fish|csh|tcsh|cmd(\\.exe)?|powershell|pwsh)$/i]',
      'CallExpression[callee.property.name=/^(runFile|spawnProgram|spawn|spawnSync|execFile|execFileSync)$/] > Literal.arguments:first-child[value=/(^|[\\\\/])(sh|bash|zsh|dash|ksh|fish|csh|tcsh|cmd(\\.exe)?|powershell|pwsh)$/i]',
    ],
    description: 'No `shell` option for a child process.',
    message: 'Run the program itself, never a shell given a command string, and drop the `shell` option (only a literal `shell: false` is accepted), and start the program with `runFile`/`spawnProgram` from src/main/proc.ts, which take an argument array and never a shell. With a shell, an argument becomes shell syntax.',
  },
  {
    name: 'no-tls-bypass',
    kind: 'syntax',
    files: [...ALL_SRC, 'scripts/**', 'tools/**'],
    selectors: [
      "Property[key.name='rejectUnauthorized']:not([value.value=true])",
      "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
      "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
    ],
    description: 'Certificate checks stay on.',
    message: 'Keep TLS verification on. To reach a test server, give it a real certificate or point the client at a fake through a test hook (src/main/testHooks.ts), never by turning verification off.',
  },

  // ── 8. SQL ─────────────────────────────────────────────────────────────────────────────────────
  {
    name: 'sql-key-pragma-in-db',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: [
      'Literal[value=/^\\s*(PRAGMA\\s+)?(re)?key\\s*=/i]',
      'TemplateElement[value.raw=/^\\s*(PRAGMA\\s+)?(re)?key\\s*=/i]',
    ],
    allow: ['packages/desktop/src/main/db/openDatabase.ts', 'packages/desktop/src/main/db/migrateToEncrypted.ts'],
    description: 'SQLCipher key/rekey pragmas only in db/openDatabase.ts and db/migrateToEncrypted.ts.',
    message:
      'Open an encrypted database with `openDatabase(file, key)` (src/main/db/openDatabase.ts); re-key only through db/migrateToEncrypted.ts. A key pragma elsewhere puts key text into SQL strings nobody reviews (audit Z-8).',
  },

  // ── 9. Vault files ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'vault-writes-through-atomic',
    kind: 'import',
    files: ['packages/desktop/src/main/vault/**/*.ts'],
    ignores: TESTS,
    sources: ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'],
    importNames: ['writeFileSync', 'renameSync', 'writeFile', 'rename'],
    allow: ['packages/desktop/src/main/vault/atomic.ts'],
    description: 'Vault files are written only through vault/atomic.ts.',
    message:
      'Write vault files with `writeJsonAtomic` (src/main/vault/atomic.ts): tmp file, fsync, rename, fsync of the folder. A plain write or rename can leave a half-written or lost header after a crash, and a lost header is lost notes.',
  },
  {
    name: 'vault-key-copies-own-memory',
    kind: 'syntax',
    files: ['packages/desktop/src/main/vault/**/*.ts'],
    ignores: TESTS,
    selectors: [
      // One argument that is not text: a byte copy (or an ArrayBuffer wrap). Decoding text
      // (`Buffer.from(s, 'base64')`) and views (`Buffer.from(ab, offset, length)`) take more arguments.
      "CallExpression[callee.object.name='Buffer'][callee.property.name='from'][arguments.length=1]:not([arguments.0.type='Literal']):not([arguments.0.type='TemplateLiteral'])",
      // Pooled or copying allocators by any reference, and computed spellings of these methods.
      "MemberExpression[object.name='Buffer'][property.name=/^(allocUnsafe|allocUnsafeSlow|copyBytesFrom)$/]",
      "MemberExpression[object.name='Buffer'][computed=true][property.value=/^(from|allocUnsafe|allocUnsafeSlow|copyBytesFrom)$/]",
    ],
    allow: Object.keys(allowlist('vault-buffer-copies')),
    description: 'No one-argument Buffer.from copies in the vault: key copies go through copyKey.',
    message:
      'Copy key bytes with `copyKey(src)` (src/main/vault/keyring.ts: `Buffer.alloc` + `src.copy(dst)`), and zero the copy in `finally` when you are its owner. ' +
      "`Buffer.from(bytes)` puts a small buffer in Node's shared 64 KiB pool slab beside unrelated data, where a copy nobody zeroes survives (audit F-FIPS-06 Z-j, Z-1).",
  },
  {
    name: 'vault-json-reads-capped',
    kind: 'syntax',
    files: ['packages/desktop/src/main/vault/**/*.ts'],
    ignores: TESTS,
    selectors: [
      "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
      "MemberExpression[object.name='JSON'][computed=true]",
      "VariableDeclarator[init.name='JSON'] > ObjectPattern",
    ],
    allow: ['packages/desktop/src/main/vault/atomic.ts', ...Object.keys(allowlist('vault-json-parse'))],
    description: 'Local vault JSON is read through readJsonCapped.',
    message:
      'Read a local vault JSON file with `readJsonCapped(path)` (src/main/vault/atomic.ts): it refuses a file over 64 KiB before `JSON.parse`. ' +
      'A local writer can make a file of any size, and an uncapped read makes start-up allocate without bound (audit F-GEN-02, T-FUZZ-13).',
  },
  {
    name: 'vault-files-read-capped',
    kind: 'syntax',
    files: MAIN,
    ignores: TESTS,
    selectors: [
      // A file read whose arguments name a vault file, by its constant or its literal name.
      `CallExpression[callee.name=/^(readFile|readFileSync|createReadStream|open|openSync)$/]:has(${VAULT_FILE_NAMES})`,
      `CallExpression[callee.property.name=/^(readFile|readFileSync|createReadStream|open|openSync)$/]:has(${VAULT_FILE_NAMES})`,
    ],
    // C1 re-review: also a path held in a const first (`const file = join(dir, LOCAL_KEYS_FILE); readFileSync(file)`).
    followConst: {
      calls: /^(readFile|readFileSync|createReadStream|open|openSync)$/,
      init: /\b(VAULT|PENDING|PREV|LOCAL_KEYS|PREUNLOCK|REJOIN_VAULT|REJOIN_KEYS|QUICK_UNLOCK|MIGRATION)_FILE\b|['"\x60](vault(\.(pending|prev|rejoin))?|local-keys(\.rejoin)?|preunlock|migration)\.json['"\x60]|['"\x60]quick-unlock\.bin['"\x60]/,
    },
    allow: ['packages/desktop/src/main/vault/atomic.ts'],
    description: 'Vault files are read anywhere in main only through readJsonCapped.',
    message:
      'Read vault.json, local-keys.json, preunlock.json, quick-unlock.bin and their pending/rejoin/migration siblings with `readJsonCapped(path)` ' +
      '(or `readJsonCappedSync`, src/main/vault/atomic.ts), wherever in main the read is: it refuses a file over 64 KiB, or one that is not a regular file, before `JSON.parse` (audit F-GEN-02).',
  },
  {
    name: 'no-sync-safe-storage',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ["CallExpression[callee.property.name=/^(encryptString|decryptString|isEncryptionAvailable)$/]"],
    description: 'No synchronous safeStorage call anywhere (audit C8 criterion 2).',
    message:
      'Keep an OS-keyring secret with `secretFile(file, secrets)` or the `SecretStorage` from src/main/secretStorage.ts (async API, real keyrings only). ' +
      'The synchronous safeStorage API is removed in Electron 46, blocks the main process on the keychain and falls back to a plaintext "basic" store on Linux (audit F-EL-01, B-5).',
  },
  {
    name: 'secrets-through-secret-storage',
    kind: 'syntax',
    files: ALL_SRC,
    ignores: TESTS,
    selectors: ["ImportSpecifier[imported.name='safeStorage']", "MemberExpression[property.name='safeStorage']"],
    allow: ['packages/desktop/src/main/secretStorage.ts'],
    description: "Electron's safeStorage only in src/main/secretStorage.ts.",
    message:
      'Take a `SecretStorage` (src/main/secretStorage.ts; index.ts makes it with `appSecretStorage()`) and store with `secretFile`: the async API, the real-keyring rule on Linux and the session-only fallback live there, once (audit B-5).',
  },

  // ── 10. Logging ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'log-through-logger',
    kind: 'syntax',
    files: MAIN_PROCESS,
    ignores: TESTS,
    selectors: [
      "Identifier[name='console']:not(Property > Identifier.key):not(MemberExpression > Identifier.property)",
      "MemberExpression[property.name='console']",
      "MemberExpression[object.name='process'][property.name=/^std(out|err)$/]",
    ],
    allow: ['packages/desktop/src/main/log/logger.ts'],
    description: 'No console in main; use the logger.',
    message:
      "Use `log.info/warn/error(scope, message, fields)` from src/main/log/logger.ts (or a `ScopedLog` passed in): it redacts paths and credentials and is off unless the user turns it on. console output lands in terminals and crash reports unredacted.",
  },
]
