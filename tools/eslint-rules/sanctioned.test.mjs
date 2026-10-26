// @ts-check
import { describe, expect, it } from 'vitest'
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'
import { SANCTIONED } from './sanctioned.mjs'

/**
 * Each table rule fires on the mistake it exists for, stays quiet in its sanctioned home and outside
 * the files it covers. `bad` reproduces a real mistake where there was one (the source is named);
 * a rule with no case here fails "every rule has cases", so an edit to a selector cannot quietly
 * turn a rule into one that matches nothing.
 *
 * @typedef {{ filename: string, code: string, count?: number }} Code
 * @type {Record<string, { bad: Code[], good: Code[] }>}
 */
const CASES = {
  'core-stays-pure': {
    bad: [
      at('packages/core/src/ids.ts', "import { randomUUID } from 'node:crypto'\nexport const id = () => randomUUID()"),
      at('packages/core/src/x.ts', "import { readFileSync } from 'fs'"),
      at('packages/core/src/x.ts', "import { useState } from 'react'"),
      at('packages/core/src/x.ts', "import { Editor } from '@tiptap/core'"),
      at('packages/core/src/x.ts', "import { toMarkdown } from '@slate/editor'"),
      // Red team residual: Electron's other entry points.
      at('packages/core/src/x.ts', "import { app } from 'electron/main'"),
    ],
    good: [at('packages/core/src/x.ts', "import { LoroDoc } from 'loro-crdt'"), at('packages/editor/src/x.ts', "import { useState } from 'react'")],
  },
  'editor-stays-in-the-renderer': {
    bad: [
      at('packages/editor/src/clipboard.ts', "import { clipboard } from 'electron'"),
      at('packages/editor/src/images.ts', "import { writeFileSync } from 'node:fs'"),
      at('packages/editor/src/x.ts', "import { CH } from '../../desktop/src/shared/ipc'"),
    ],
    good: [at('packages/editor/src/x.ts', "import { PageDoc } from '@slate/core'\nimport type { EditorServices } from './services'")],
  },
  'renderer-through-bridge': {
    bad: [
      at('packages/desktop/src/renderer/src/App.tsx', "import { ipcRenderer } from 'electron'"),
      at('packages/desktop/src/renderer/src/x.ts', "import { readFile } from 'node:fs/promises'"),
      at('packages/desktop/src/renderer/src/settings/x.ts', "import { readSettings } from '../../../main/settings'"),
      at('packages/desktop/src/renderer/src/x.ts', "import type { Services } from '../../main/services'"),
      at('packages/desktop/src/renderer/src/x.ts', "const fs = require('fs')"),
      at('packages/desktop/src/renderer/src/x.ts', "import { ipcRenderer } from 'electron/renderer'"),
      at('packages/desktop/src/renderer/src/x.ts', "import { clipboard } from 'electron/common'"),
    ],
    good: [at('packages/desktop/src/renderer/src/x.ts', "import type { Settings } from '../../shared/api'\nimport { PageDoc } from '@slate/core'")],
  },
  'preload-electron-and-shared': {
    bad: [
      at('packages/desktop/src/preload/index.ts', "import { readFileSync } from 'node:fs'"),
      at('packages/desktop/src/preload/index.ts', "import { services } from '../main/services'"),
      at('packages/desktop/src/preload/index.ts', "import { mapOneNotePage } from '@slate/importer'"),
    ],
    good: [
      at(
        'packages/desktop/src/preload/index.ts',
        "import { contextBridge, ipcRenderer } from 'electron'\nimport { CH } from '../shared/ipc'\nimport type { ImportProgress } from '@slate/importer'",
      ),
    ],
  },
  'main-never-imports-renderer': {
    bad: [at('packages/desktop/src/main/menu.ts', "import { MENU } from '../renderer/src/menu'")],
    good: [at('packages/desktop/src/main/menu.ts', "import { CH } from '../shared/ipc'")],
  },
  'shared-runs-everywhere': {
    bad: [
      at('packages/desktop/src/shared/theme/x.ts', "import { nativeTheme } from 'electron'"),
      at('packages/desktop/src/shared/x.ts', "import { join } from 'path'"),
      at('packages/desktop/src/shared/x.ts', "import { log } from '../main/log/logger'"),
    ],
    good: [at('packages/desktop/src/shared/x.ts', "import { redact } from './redact'\nimport type { ImportProgress } from '@slate/importer'")],
  },
  'renderer-no-network': {
    bad: [
      at('packages/editor/src/images.ts', 'export async function grab(src: string) { return (await fetch(src)).arrayBuffer() }'),
      at('packages/desktop/src/renderer/src/x.ts', "const ws = new WebSocket('ws://localhost:1')"),
      at('packages/desktop/src/renderer/src/x.ts', "navigator.sendBeacon('https://x.dev', 'a')"),
      at('packages/desktop/src/renderer/src/x.ts', "window.open('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.ts', 'const x = new XMLHttpRequest()'),
      // Red team 1a: aliases and computed access.
      at('packages/desktop/src/renderer/src/x.ts', "const f = fetch\nvoid f('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.ts', "void window['fetch']('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.ts', "const { fetch: ff } = window\nvoid ff('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.ts', "void Reflect.construct(WebSocket, ['wss://x.dev'])"),
    ],
    good: [
      at('packages/desktop/src/renderer/src/x.ts', "void window.slate.openExternal('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.ts', 'export const o = { fetch: 1 }'),
      at('packages/desktop/src/main/update/electronBackend.ts', "void fetch('https://x.dev')"),
      at('packages/desktop/src/renderer/src/x.test.ts', "void fetch('https://x.dev')"),
    ],
  },
  'renderer-no-code-eval': {
    bad: [
      // Red team R2: markup sinks by other names.
      at('packages/editor/src/x.ts', "declare const html: string\nexport const f = document.createRange().createContextualFragment(html)"),
      at('packages/editor/src/x.ts', "declare const el: HTMLElement, html: string\nObject.assign(el, { innerHTML: html })"),
      at('packages/desktop/src/renderer/src/x.ts', "declare const el: HTMLElement, doc: Document\nel.append(document.adoptNode(doc.body))"),
      at('packages/editor/src/clipboard.ts', 'export function show(el: HTMLElement, html: string) { el.innerHTML = html }'),
      at('packages/desktop/src/renderer/src/x.tsx', 'export const A = (p: { html: string }) => <div dangerouslySetInnerHTML={{ __html: p.html }} />'),
      at('packages/desktop/src/renderer/src/x.ts', "eval('1')"),
      at('packages/desktop/src/renderer/src/x.ts', "const f = new Function('return 1')"),
      at('packages/desktop/src/renderer/src/x.ts', "setTimeout('alert(1)', 10)"),
      at('packages/desktop/src/renderer/src/x.ts', "document.body.insertAdjacentHTML('beforeend', '<b>')"),
      at('packages/desktop/src/renderer/src/x.ts', "document.write('<b>')"),
    ],
    good: [
      at('packages/editor/src/clipboard.ts', "const doc = new DOMParser().parseFromString('<b>', 'text/html')\nexport const html = doc.body.innerHTML"),
      at('packages/desktop/src/renderer/src/x.ts', 'setTimeout(() => {}, 10)'),
    ],
  },
  'ipc-through-registrar': {
    bad: [
      at('packages/desktop/src/main/x.ts', "import { ipcMain as bus } from 'electron/main'\nbus.handle('x', () => 1)"),
      // index.ts before the registrar: `ipcMain.handle(CH.mcpLauncher, …)` next to a monkey-patched ipcMain.handle.
      at('packages/desktop/src/main/index.ts', "import { app, ipcMain } from 'electron'\nipcMain.handle('mcp:launcher', () => app.getVersion())"),
      { ...at('packages/desktop/src/main/log/configure.ts', "import { ipcMain } from 'electron'\nexport const h = ipcMain.handle.bind(ipcMain)"), count: 1 },
      // Red team 2d: side doors around ipcMain.
      at('packages/desktop/src/main/x.ts', "import * as electron from 'electron'\nelectron.ipcMain.on('rt', () => {})"),
      at('packages/desktop/src/main/x.ts', "declare const win: { webContents: { ipc: { handle(c: string, f: () => number): void } } }\nwin.webContents.ipc.handle('rt:raw', () => 1)"),
      at('packages/desktop/src/main/x.ts', "declare const wc: { ipc: unknown }\nexport const r = wc.ipc"),
      at('packages/desktop/src/main/x.ts', "import { MessageChannelMain } from 'electron'\nexport const m = MessageChannelMain"),
    ],
    good: [
      at('packages/desktop/src/main/ipcGuard.ts', "import { ipcMain } from 'electron'\nexport const raw = ipcMain"),
      at('packages/desktop/src/main/index.ts', "import { app, BrowserWindow } from 'electron'\nexport const x = [app, BrowserWindow]"),
      // Red team usability: a namespace import that never touches ipcMain is not an IPC question.
      at('packages/desktop/src/main/x.ts', "import * as electron from 'electron'\nexport const v = electron.app.getVersion()"),
    ],
  },
  'editor-rules-from-spec': {
    bad: [
      // Red team G2-1: "making shortcuts work" by turning every input rule on in the box editor.
      { ...at('packages/editor/src/BoxEditor.tsx', 'export const options = { enableInputRules: true, enablePasteRules: false }'), count: 2 },
      at('packages/editor/src/BoxEditor.tsx', 'export const options = { enablePasteRules: true }'),
    ],
    good: [
      at('packages/editor/src/inputRules.ts', 'export const options = { enableInputRules: true, enablePasteRules: false }'),
      at('packages/editor/src/BoxEditor.tsx', "import { editorRuleOptions } from './inputRules'\nexport const options = { ...editorRuleOptions({ markdownShortcuts: false, autoBullets: true }) }"),
    ],
  },
  'block-format-from-commands': {
    bad: [
      // Red team final F-2: a Space shortcut that turns `# ` into a heading.
      at('packages/editor/src/keymap.ts', "declare const editor: { chain(): { setHeading(o: object): { run(): boolean } } }\nexport const keys = { Space: () => editor.chain().setHeading({ level: 1 }).run() }"),
      at('packages/editor/src/BoxEditor.tsx', "declare const c: { toggleBulletList(): boolean }\nexport const f = () => c.toggleBulletList()"),
      at('packages/desktop/src/renderer/src/App.tsx', "declare const c: { toggleCodeBlock(): boolean }\nexport const f = () => c['toggleCodeBlock']()"),
      at('packages/editor/src/x.ts', "declare const c: { setNode(n: string): boolean }\nexport const f = () => c.setNode('heading')"),
      at('packages/editor/src/x.ts', 'export const props = { handleTextInput: () => false }'),
      at('packages/editor/src/x.ts', 'export const plugin = { appendTransaction() { return null } }'),
      at('packages/editor/src/x.ts', 'declare const inputRules: (o: object) => unknown\nexport const p = inputRules({ rules: [] })'),
      at('packages/editor/src/x.ts', "import Typography from '@tiptap/extension-typography'\nexport const t = Typography"),
    ],
    good: [
      at('packages/desktop/src/renderer/src/Toolbar.tsx', "declare const c: { toggleHeading(o: object): boolean }\nexport const f = () => c.toggleHeading({ level: 1 })"),
      at('packages/editor/src/extensions.ts', "declare const chain: () => { toggleBulletList(): { run(): boolean } }\nexport const f = () => chain().toggleBulletList().run()"),
      at('packages/editor/src/keymap.ts', 'declare const session: { undo(): void }\nexport const keys = { "Mod-z": () => { session.undo(); return true } }'),
      at('packages/editor/test/x.test.ts', "declare const c: { setHeading(o: object): boolean }\nc.setHeading({ level: 1 })"),
    ],
  },
  'key-bytes-in-the-vault': {
    bad: [
      // Red team G2-5/G2-8: unwrap a KeyRing key outside the vault and copy or stringify it.
      at('packages/desktop/src/main/sync/feature.ts', "import { vaultKeyBuffer, type KeyBytes } from '../vault/keyring'\ndeclare const k: KeyBytes\nexport const hex = vaultKeyBuffer(k).toString('hex')"),
      at('packages/sync/src/feature.ts', "declare const vaultKeyBuffer: (k: unknown) => Buffer\nexport const copy = Buffer.from(vaultKeyBuffer(1))"),
      at('packages/desktop/src/main/sync/feature.ts', "import * as ring from '../vault/keyring'\ndeclare const k: ring.KeyBytes\nexport const b = ring.vaultKeyBuffer(k)"),
    ],
    good: [
      at('packages/desktop/src/main/vault/migration.ts', "import { vaultKeyBuffer, type KeyBytes } from './keyring'\ndeclare const k: KeyBytes\nexport const b = vaultKeyBuffer(k)"),
      at('packages/desktop/src/main/db/keyHandle.ts', "import { vaultKeyBuffer, type KeyBytes } from '../vault/keyring'\ndeclare const k: KeyBytes\nexport const b = vaultKeyBuffer(k)"),
      at('packages/desktop/src/main/sync/feature.ts', "import { withKeyBytes, type KeyBytes } from '../vault/keyring'\ndeclare const k: KeyBytes\nexport const n = withKeyBytes(k, (b) => b.length)"),
    ],
  },
  'no-key-bytes-cast': {
    bad: [
      // Red team G2-5: the opaque type is one double cast away from a Buffer.
      at('packages/desktop/src/main/sync/feature.ts', "import type { KeyBytes } from '../vault/keyring'\ndeclare const k: KeyBytes\nexport const b = k as unknown as Buffer"),
      at('packages/desktop/src/main/vault/feature.ts', 'declare const k: object\nexport const b = k as unknown as Uint8Array'),
      at('packages/desktop/src/main/ipc.ts', 'declare const b: Buffer\nexport const k = b as unknown as KeyBytes\ntype KeyBytes = { k: 1 }'),
      at('packages/desktop/src/main/ipc.ts', 'declare const k: object\nexport const b = <Buffer>(<unknown>k)'),
    ],
    good: [
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const k: object\nexport const b = k as unknown as Buffer'),
      at('packages/desktop/src/main/update/verifier.ts', 'declare const v: object\nexport const r = v as unknown as { ok: true }'),
      at('packages/desktop/src/main/update/electronBackend.ts', 'declare const v: object\nexport const r = v as unknown as AsyncIterable<Uint8Array>'),
    ],
  },
  'ipc-registrar-once': {
    bad: [at('packages/desktop/src/main/feature.ts', "import { createIpc } from './ipcGuard'\nexport const always = createIpc(() => true, () => true)"), at('packages/desktop/src/main/feature.ts', "import { guardHandlers } from './ipcGuard'\ndeclare const r: never\nexport const g = guardHandlers(r, () => true)")],
    good: [at('packages/desktop/src/main/index.ts', "import { createIpc } from './ipcGuard'\nexport const ipc = createIpc(() => false, () => false)"), at('packages/desktop/src/main/ipcGuard.test.ts', "import { createIpc } from './ipcGuard'\ndeclare const r: never\ncreateIpc(() => true, () => false, r)")],
  },
  'preload-exposes-only-slate': {
    bad: [
      // Red team 2e: an alias of ipcRenderer, a generic invoke, and a second global.
      at('packages/desktop/src/preload/index.ts', "import { ipcRenderer } from 'electron'\nconst r = ipcRenderer\nexport const x = r"),
      at('packages/desktop/src/preload/index.ts', "import { contextBridge, ipcRenderer } from 'electron'\ncontextBridge.exposeInMainWorld('slate', { ipc: ipcRenderer })"),
      at('packages/desktop/src/preload/index.ts', "import { contextBridge } from 'electron'\ncontextBridge.exposeInMainWorld('electron', {})"),
    ],
    good: [
      at('packages/desktop/src/preload/index.ts', "import { contextBridge, ipcRenderer } from 'electron'\nimport { CH } from '../shared/ipc'\ncontextBridge.exposeInMainWorld('slate', { load: (id: string) => ipcRenderer.invoke(CH.docsLoad, id) })"),
    ],
  },
  'crypto-stays-in-the-vault': {
    bad: [
      at('packages/desktop/src/main/sync/git/auth.ts', "import { createCipheriv } from 'node:crypto'"),
      at('packages/sync/src/gitDrive.ts', "import { createHash } from 'crypto'"),
      // Red team 4d: a new primitive in a file allowlisted for a different one (the nearest example).
      at('packages/desktop/src/main/blobs.ts', "import { createHash, createCipheriv } from 'node:crypto'"),
      at('packages/desktop/src/main/theme/themeStore.ts', "import * as nodeCrypto from 'node:crypto'"),
      // C4 (T-STATIC-02): the vault, sync and the database have no node:crypto at all; @slate/native does it.
      at('packages/desktop/src/main/vault/envelope.ts', "import { createCipheriv } from 'node:crypto'"),
      at('packages/desktop/src/main/vault/header.ts', "import { createHmac, randomBytes } from 'node:crypto'"),
      at('packages/desktop/src/main/sync/encryptingDrive.ts', "import { createHash } from 'node:crypto'"),
      at('packages/desktop/src/main/db/migrateToEncrypted.ts', "import { createHash } from 'node:crypto'"),
      at('packages/desktop/src/main/vault/atomic.ts', "import { randomBytes } from 'node:crypto'"),
    ],
    good: [
      at('packages/desktop/src/main/update/signature.ts', "import { createHash, createPublicKey, verify } from 'node:crypto'"),
      at('packages/desktop/src/main/blobs.ts', "import { createHash } from 'node:crypto'"),
      at('packages/desktop/src/main/vault/envelope.test.ts', "import { randomBytes } from 'node:crypto'"),
    ],
  },
  'no-get-builtin-module': {
    bad: [
      // Review C4 L3: process.getBuiltinModule hands out node:crypto past every import check.
      at('packages/desktop/src/main/vault/x.ts', "export const c = process.getBuiltinModule('node:crypto')"),
      at('packages/desktop/src/main/x.ts', "const name = 'crypto'\nexport const c = globalThis.process.getBuiltinModule(name)"),
      at('packages/sync/src/x.ts', "export const cp = process.getBuiltinModule('node:child_process')"),
      // Re-review L3-R: computed access and destructuring.
      at('packages/desktop/src/main/vault/x.ts', "export const c = process['getBuiltinModule']('node:crypto')"),
      at('packages/desktop/src/main/vault/x.ts', "const { getBuiltinModule } = process\nexport const c = getBuiltinModule('node:crypto')"),
      at('packages/desktop/src/main/vault/x.ts', "const { getBuiltinModule: load } = globalThis.process\nexport const c = load('node:crypto')"),
    ],
    good: [at('packages/desktop/src/main/vault/x.test.ts', "export const c = process.getBuiltinModule('node:crypto')")],
  },
  'crypto-through-native': {
    bad: [
      // C4: Argon2id, AES, HMAC and the rest run in @slate/native; a JS crypto library is a second, unvalidated stack.
      at('packages/desktop/src/main/vault/kdf.ts', "import { argon2id } from 'hash-wasm'"),
      at('packages/desktop/src/main/x.ts', "import nacl from 'tweetnacl'"),
      at('packages/desktop/src/main/x.ts', "import { gcm } from '@noble/ciphers/aes'"),
      at('packages/desktop/src/renderer/src/x.ts', "import CryptoJS from 'crypto-js'"),
      at('packages/sync/src/x.ts', "const forge = require('node-forge')"),
      // Only @slate/native's index: its internals and the .node binary are not a second way in.
      at('packages/desktop/src/main/db/openDatabase.ts', "import createDatabase from '@slate/native/sqlite/database.js'"),
      at('packages/desktop/src/main/x.ts', "const n = require('../../../native/prebuilds/darwin-arm64/slate_native.node')"),
    ],
    good: [
      at('packages/desktop/src/main/vault/native.ts', "import type { KeyHandle, SlateNative } from '@slate/native'"),
      at('packages/desktop/src/main/native/launch.ts', "import { loadNative } from '@slate/native'"),
      at('packages/native/index.ts', "import createDatabase from './sqlite/database.js'"),
      at('packages/desktop/src/main/vault/kdf.test.ts', "import { argon2id } from 'hash-wasm'"),
    ],
  },
  'legacy-crypto-in-v1-path': {
    bad: [
      // A suite-0x01 KDF or name cipher reached from anywhere but the v1 read path (C5 criterion 2).
      at('packages/desktop/src/main/vault/header.ts', "declare const n: { hkdfLegacy(a: number, b: Uint8Array, c: string): number }\nn.hkdfLegacy(1, new Uint8Array(0), 'slate/v1/sync')"),
      at('packages/desktop/src/main/sync/encryptingDrive.ts', "declare const n: { aesEcbBlock(a: number, b: Uint8Array, c: boolean): Uint8Array }\nn.aesEcbBlock(1, new Uint8Array(16), true)"),
      at('packages/desktop/src/main/vault/quickUnlock.ts', "declare const n: Record<string, (...a: unknown[]) => unknown>\nn['hkdfFromSecret'](new Uint8Array(32))"),
      at('packages/desktop/src/main/vault/x.ts', "declare const n: { hkdfLegacy(): number }\nconst { hkdfLegacy } = n\nhkdfLegacy()"),
      // C7's decoded recovery key into suite 0x01's KEK_rc is the same legacy HKDF.
      at('packages/desktop/src/main/vault/header.ts', "declare const n: { hkdfFromRecovery(a: number, b: Uint8Array, c: string): number }\nn.hkdfFromRecovery(1, new Uint8Array(0), 'slate/v1/recovery')"),
    ],
    good: [
      at('packages/desktop/src/main/vault/suite1.ts', "declare const n: { hkdfLegacy(a: number, b: Uint8Array, c: string): number }\nn.hkdfLegacy(1, new Uint8Array(0), 'slate/v1/sync')"),
      at('packages/desktop/src/main/vault/header.ts', "declare const n: { kbkdf(a: number, b: string, c: Uint8Array): number }\nn.kbkdf(1, 'slate/v2/sync', new Uint8Array(16))"),
    ],
  },
  'suite1-from-the-dispatch-sites': {
    bad: [
      at('packages/desktop/src/main/vault/migration.ts', "import { v1Subkey } from './suite1'\nexport { v1Subkey }"),
      at('packages/desktop/src/main/sync/encryptingDrive.ts', "import { v1FileKey } from '../vault/suite1'\nexport { v1FileKey }"),
      // Review C5 N2: with an extension, as ESM resolution allows.
      at('packages/desktop/src/main/sync/encryptingDrive.ts', "import { v1FileKey } from '../vault/suite1.js'\nexport { v1FileKey }"),
      at('packages/desktop/src/main/vault/migration.ts', "import { v1Subkey } from './suite1.ts'\nexport { v1Subkey }"),
    ],
    good: [
      at('packages/desktop/src/main/vault/keyring.ts', "import { v1Subkey } from './suite1'\nexport { v1Subkey }"),
      at('packages/desktop/src/main/vault/migration.ts', "import { SUITE } from './suite'\nexport { SUITE }"),
    ],
  },
  'argon2-in-kdf': {
    bad: [
      at('packages/desktop/src/main/vault/header.ts', "declare const n: { argon2idAsync(a: Uint8Array, b: Uint8Array, c: number, d: number): Promise<number> }\nvoid n.argon2idAsync(new Uint8Array(1), new Uint8Array(16), 64, 1)"),
      at('packages/desktop/src/main/vault/migration.ts', "declare const n: { argon2id(a: Uint8Array, b: Uint8Array, c: number, d: number): number }\nn.argon2id(new Uint8Array(1), new Uint8Array(16), 64, 1)"),
    ],
    good: [
      at('packages/desktop/src/main/vault/kdf.ts', "declare const n: { argon2idAsync(a: Uint8Array, b: Uint8Array, c: number, d: number): Promise<number> }\nvoid n.argon2idAsync(new Uint8Array(1), new Uint8Array(16), 64, 1)"),
      at('packages/desktop/src/main/vault/header.ts', "const alg = 'argon2id'\nexport { alg }"),
    ],
  },
  'no-ecb': {
    bad: [
      // vault/names.ts's suite 0x01 cipher, copied anywhere else.
      at('packages/desktop/src/main/sync/encryptingDrive.ts', "import { createCipheriv } from 'node:crypto'\ndeclare const key: Buffer\nconst c = createCipheriv('aes-256-ecb', key, null)"),
      at('packages/desktop/src/main/x.ts', "import * as crypto from 'node:crypto'\ndeclare const key: Buffer\nconst c = crypto.createDecipheriv('AES-128-ECB', key, null)"),
      // Red team 4b: the mode built from parts or as a template literal.
      at('packages/desktop/src/main/x.ts', "import { createCipheriv } from 'node:crypto'\ndeclare const key: Buffer\nconst mode = 'aes-256-' + 'ecb'\nconst c = createCipheriv(mode, key, null)"),
      at('packages/desktop/src/main/x.ts', "import { createCipheriv } from 'node:crypto'\ndeclare const key: Buffer\nconst c = createCipheriv(`aes-256-ecb`, key, null)"),
    ],
    good: [
      at('packages/desktop/src/main/vault/names.ts', "import { createCipheriv } from 'node:crypto'\ndeclare const key: Buffer\nconst c = createCipheriv('aes-256-ecb', key, null)"),
      at('packages/desktop/src/main/vault/crypto.ts', "import { createCipheriv } from 'node:crypto'\ndeclare const key: Buffer, iv: Buffer\nconst c = createCipheriv('aes-256-gcm', key, iv)"),
    ],
  },
  'no-math-random': {
    bad: [
      at('packages/desktop/src/renderer/src/x.ts', 'export const id = Math.random().toString(36).slice(2)'),
      at('packages/core/src/x.ts', 'export const n = Math.random()'),
      // Red team 4c.
      at('packages/core/src/x.ts', "export const n = Math['random']()"),
      at('packages/core/src/x.ts', 'export const rnd = Math.random'),
    ],
    good: [at('packages/core/src/x.ts', "import { randomInt } from './ids'\nexport const n = randomInt(10)"), at('packages/core/test/x.test.ts', 'export const n = Math.random()')],
  },
  'no-web-crypto': {
    bad: [
      // Red team 4a: AES-CBC with a zero IV through the Web Crypto global, where the old message pointed agents.
      { ...at('packages/desktop/src/main/rt.ts', "declare const key: CryptoKey, data: Uint8Array\nvoid crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, data)"), count: 2 },
      at('packages/desktop/src/renderer/src/x.ts', 'export const a = globalThis.crypto.getRandomValues(new Uint8Array(4))'),
      at('packages/editor/src/x.ts', "import { webcrypto } from 'node:crypto'\nexport const w = webcrypto"),
    ],
    good: [
      at('packages/core/src/ids.ts', 'export const id = () => crypto.randomUUID()'),
      at('packages/desktop/src/main/x.ts', "import { newId } from '@slate/core'\nexport const id = newId()"),
      at('packages/desktop/src/main/x.ts', 'export const o = { crypto: 1 }\nexport const n = o.crypto'),
    ],
  },
  'no-create-require': {
    bad: [
      at('packages/desktop/src/main/x.ts', "import { createRequire } from 'node:module'\nconst c = createRequire(__filename)('node:' + 'crypto')"),
      at('packages/desktop/src/main/x.ts', "import * as m from 'node:module'\nexport const r = m.createRequire(__filename)"),
    ],
    good: [at('packages/desktop/src/main/x.ts', "import { join } from 'node:path'\nexport const p = join('a')"), at('packages/desktop/src/main/x.test.ts', "import { createRequire } from 'node:module'\nexport const r = createRequire(__filename)")],
  },
  'no-weak-web-preferences': {
    bad: [
      at('packages/desktop/src/main/index.ts', "import { BrowserWindow } from 'electron'\nnew BrowserWindow({ webPreferences: { sandbox: false, contextIsolation: true } })"),
      at('packages/desktop/src/main/index.ts', "import { BrowserWindow } from 'electron'\nnew BrowserWindow({ webPreferences: { nodeIntegration: true } })"),
      at('packages/desktop/src/main/index.ts', "declare const isE2E: boolean\nexport const o = { webPreferences: { contextIsolation: !isE2E } }"),
      at('packages/desktop/src/main/index.ts', 'export const o = { webPreferences: { webSecurity: false } }'),
      at('packages/desktop/src/main/index.ts', 'export const o = { webPreferences: { allowRunningInsecureContent: true } }'),
      // Red team 8a: preferences built apart from the window, by shorthand or spread.
      at('packages/desktop/src/main/x.ts', 'export const o = { sandbox: false }'),
      at('packages/desktop/src/main/windows.ts', "const webPreferences = { preload: 'p' }\nexport const o = { webPreferences }"),
      at('packages/desktop/src/main/windows.ts', "declare const base: object\nexport const o = { webPreferences: { ...base, sandbox: true } }"),
    ],
    good: [
      at('packages/desktop/src/main/index.ts', "import { join } from 'node:path'\nexport const o = { webPreferences: { preload: join('a'), contextIsolation: true, sandbox: true, spellcheck: false } }"),
    ],
  },
  'windows-from-the-factory': {
    bad: [
      at('packages/desktop/src/main/x.ts', "import * as e from 'electron'\nexport const w = new e.BrowserWindow()"),
      at('packages/desktop/src/main/x.ts', "import { WebContentsView } from 'electron'\nexport const v = new WebContentsView()"),at('packages/desktop/src/main/update/x.ts', "import { BrowserWindow } from 'electron'\nexport const w = new BrowserWindow({ show: false })"), at('packages/desktop/src/main/index.ts', "import { BrowserWindow } from 'electron'\nexport const w = new BrowserWindow({ show: false })")],
    good: [at('packages/desktop/src/main/windows.ts', "import { BrowserWindow } from 'electron'\nexport const w = new BrowserWindow({ show: false })")],
  },
  'open-external-safely': {
    bad: [
      at('packages/desktop/src/main/x.ts', "import { shell } from 'electron/common'\nshell.beep()"),
      // index.ts before openExternalSafe: MSAL's sign-in page handed straight to the system.
      at('packages/desktop/src/main/index.ts', "import { shell } from 'electron'\nexport const deps = { openBrowser: (url: string) => shell.openExternal(url) }"),
      at('packages/desktop/src/main/update/electronBackend.ts', "import { shell } from 'electron'\nexport const open = shell.openExternal"),
      // Red team 8c: a destructured openExternal, and openPath, which the old rule did not cover.
      at('packages/desktop/src/main/x.ts', "import { shell } from 'electron'\nconst { openExternal } = shell\nvoid openExternal('file:///x')"),
      at('packages/desktop/src/main/x.ts', "import * as electron from 'electron'\nvoid electron.shell.openPath('/tmp/a.app')"),
    ],
    good: [
      at('packages/desktop/src/main/openExternal.ts', "import { shell } from 'electron'\nexport const open = (u: string) => shell.openExternal(u)"),
      at('packages/desktop/src/main/x.ts', "import { app } from 'electron'\nimport { revealInFolder } from './openExternal'\nrevealInFolder(app.getPath('logs'))"),
    ],
  },
  'no-shell-exec': {
    bad: [
      at('packages/desktop/src/main/sync/git/auth.ts', "import { exec } from 'node:child_process'\ndeclare const dir: string\nexec(`git -C ${dir} status`)"),
      at('scripts/x.mjs', "import { execSync } from 'child_process'\nexecSync('ls')"),
    ],
    good: [at('packages/desktop/src/main/sync/git/auth.ts', "import { execFile } from 'node:child_process'\nexecFile('git', ['status'])")],
  },
  'no-shell-option': {
    bad: [
      at('packages/sync/src/gitRunner.ts', "import { spawn } from 'node:child_process'\nspawn('git', ['status'], { shell: true })"),
      // Red team 7a: the usual cross-platform idiom, a variable, and a computed key.
      at('packages/desktop/src/main/x.ts', "import { spawn } from 'node:child_process'\nspawn('open', ['a'], { shell: process.platform === 'win32' })"),
      at('packages/desktop/src/main/x.ts', "import { spawn } from 'node:child_process'\ndeclare const useShell: boolean\nspawn('open', ['a'], { shell: useShell })"),
      at('packages/desktop/src/main/x.ts', "import { execFile } from 'node:child_process'\nconst k = 'shell'\nexecFile('open', ['a'], { [k]: true })"),
      at('packages/desktop/src/main/x.ts', "import * as cp from 'node:child_process'\nconst shell = true\ncp.spawnSync('open', ['a'], { shell })"),
      // Red team re-run: a shell handed a command string, through the sanctioned wrapper too.
      at('packages/desktop/src/main/x.ts', "import { runFile } from './proc'\ndeclare const n: string\nvoid runFile('/bin/sh', ['-c', 'git log ' + n])"),
      at('packages/desktop/src/main/x.ts', "import { spawn } from 'node:child_process'\nspawn('bash', ['-lc', 'id'])"),
    ],
    good: [at('packages/sync/src/gitRunner.ts', "import { spawn } from 'node:child_process'\nspawn('git', ['status'], { shell: false })"), at('packages/desktop/src/main/x.ts', "import { shell } from 'electron'\nexport const deps = { shell }")],
  },
  'no-tls-bypass': {
    bad: [
      at('packages/desktop/src/main/onenote/auth.ts', "import { request } from 'node:https'\nrequest({ host: 'x', rejectUnauthorized: false })"),
      at('scripts/x.mjs', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'"),
      // Red team 7b: a variable and a negated literal.
      at('packages/desktop/src/main/onenote/auth.ts', "import { request } from 'node:https'\ndeclare const insecure: boolean\nrequest({ host: 'x', rejectUnauthorized: insecure })"),
      at('packages/desktop/src/main/onenote/auth.ts', "import { request } from 'node:https'\nrequest({ host: 'x', rejectUnauthorized: !1 })"),
    ],
    good: [
      at('packages/desktop/src/main/onenote/auth.ts', "import { request } from 'node:https'\nrequest({ host: 'x' })"),
      at('packages/desktop/src/main/onenote/auth.ts', "import { request } from 'node:https'\nrequest({ host: 'x', rejectUnauthorized: true })"),
    ],
  },
  'child-process-through-proc': {
    bad: [
      at('packages/desktop/src/main/mcp/x.ts', "import { spawn } from 'node:child_process'\nspawn('open', ['a'])"),
      at('packages/editor/src/x.ts', "import cp from 'child_process'\nvoid cp"),
    ],
    good: [
      at('packages/desktop/src/main/proc.ts', "import { spawn } from 'node:child_process'\nexport const s = spawn"),
      at('packages/desktop/src/main/mcp/x.ts', "import { runFile } from '../proc'\nvoid runFile('open', ['a'])"),
      at('packages/desktop/src/main/x.test.ts', "import { execFileSync } from 'node:child_process'\nexecFileSync('git', ['init'])"),
    ],
  },
  'sql-key-pragma-in-db': {
    bad: [
      // audit Z-8: the key as SQL text, outside the two reviewed files.
      at('packages/desktop/src/main/store.ts', "declare const db: { pragma(s: string): void }, hex: string\ndb.pragma(`key = \"x'${hex}'\"`)"),
      at('packages/desktop/src/main/sync/x.ts', "declare const db: { exec(s: string): void }\ndb.exec(\"PRAGMA rekey = 'x'\")"),
    ],
    good: [
      at('packages/desktop/src/main/db/openDatabase.ts', "declare const db: { pragma(s: string): void }, hex: string\ndb.pragma(`key = \"x'${hex}'\"`)"),
      at('packages/desktop/src/main/store.ts', "declare const db: { pragma(s: string): void }\ndb.pragma('journal_mode = WAL')"),
    ],
  },
  'vault-writes-through-atomic': {
    bad: [
      // unlock.ts and migration.ts (phase 10 F2 #3): a rejoin finished by plain renames of the header.
      at('packages/desktop/src/main/vault/unlock.ts', "import { existsSync, renameSync } from 'node:fs'\nrenameSync('vault.rejoin.json', 'vault.json')"),
      at('packages/desktop/src/main/vault/header.ts', "import { writeFileSync } from 'node:fs'\nwriteFileSync('vault.json', '{}')"),
      at('packages/desktop/src/main/vault/header.ts', "import { writeFile } from 'node:fs/promises'\nawait writeFile('vault.json', '{}')"),
    ],
    good: [
      at('packages/desktop/src/main/vault/atomic.ts', "import { rename } from 'node:fs/promises'\nawait rename('a', 'b')"),
      at('packages/desktop/src/main/vault/header.ts', "import { readFileSync } from 'node:fs'\nreadFileSync('vault.json')"),
    ],
  },
  'vault-key-copies-own-memory': {
    bad: [
      // audit Z-j (vault/keyring.ts:55 before C1): every key handed out was a pooled Buffer.from copy.
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const key: Buffer\nexport const copy = Buffer.from(key)'),
      // vault/unlock.ts:47 and the Argon2 worker's reply before C1.
      at('packages/desktop/src/main/vault/unlock.ts', 'declare const secret: { mk: Buffer }\nexport const mk = Buffer.from(secret.mk)'),
      at('packages/desktop/src/main/vault/argon2.worker.ts', 'declare const m: { ok: Uint8Array }\nexport const kek = Buffer.from(m.ok)'),
      // vault/crypto.ts:21 before C1: the HKDF output wrapped without zeroing its ArrayBuffer.
      at('packages/desktop/src/main/vault/crypto.ts', "import { hkdfSync } from 'node:crypto'\ndeclare const k: Buffer\nexport const sub = Buffer.from(hkdfSync('sha256', k, '', 'i', 32))"),
      // Review phase11-c1: the pooled spellings an agent writes by accident, and the computed one.
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const src: Buffer\nconst dst = Buffer.allocUnsafe(src.length)\nsrc.copy(dst)'),
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const src: Buffer\nexport const dst = Buffer.allocUnsafeSlow(src.length)'),
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const src: Buffer\nexport const dst = Buffer.copyBytesFrom(src)'),
      at('packages/desktop/src/main/vault/keyring.ts', "declare const src: Buffer\nexport const dst = Buffer['from'](src)"),
    ],
    good: [
      at('packages/desktop/src/main/vault/keyring.ts', 'declare const src: Buffer\nconst dst = Buffer.alloc(src.length)\nsrc.copy(dst)'),
      at('packages/desktop/src/main/vault/header.ts', "declare const s: string, n: string\nexport const a = Buffer.from(`v1|${s}`, 'utf8')\nexport const b = Buffer.from(n, 'base64')\nexport const c = Buffer.from('SLE1')"),
      at('packages/desktop/src/main/vault/crypto.ts', 'declare const b: Uint8Array\nexport const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength)'),
      at('packages/desktop/src/main/sync/x.ts', 'declare const key: Buffer\nexport const copy = Buffer.from(key)'),
    ],
  },
  'vault-json-reads-capped': {
    bad: [
      // audit F-GEN-02 (vault/unlock.ts:32, vaultCheck.ts:27, preunlock.ts:62, quickUnlock.ts:68 before C1): uncapped local reads.
      at('packages/desktop/src/main/vault/unlock.ts', "import { readFile } from 'node:fs/promises'\nexport const read = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as unknown"),
      at('packages/desktop/src/main/vault/migration.ts', "import { readFileSync } from 'node:fs'\nexport const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as unknown"),
      // Review phase11-c1: the destructured and computed spellings.
      at('packages/desktop/src/main/vault/unlock.ts', "declare const text: string\nconst { parse } = JSON\nexport const v = parse(text) as unknown"),
      at('packages/desktop/src/main/vault/unlock.ts', "declare const text: string\nexport const v = JSON['parse'](text) as unknown"),
    ],
    good: [
      at('packages/desktop/src/main/vault/atomic.ts', 'declare const text: string\nexport const v = JSON.parse(text) as unknown'),
      at('packages/desktop/src/main/vault/unlock.ts', "import { readJsonCapped } from './atomic'\nexport const read = (p: string) => readJsonCapped(p)"),
      at('packages/desktop/src/main/settings.ts', 'declare const text: string\nexport const v = JSON.parse(text) as unknown'),
    ],
  },
  'vault-files-read-capped': {
    bad: [
      // index.ts:433 and db/migrateToEncrypted.ts:218 before the C1 review fixes: uncapped reads of vault files outside vault/.
      at('packages/desktop/src/main/index.ts', "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\ndeclare const VAULT_FILE: string\nexport const h = JSON.parse(readFileSync(join('d', VAULT_FILE), 'utf8')) as unknown"),
      at('packages/desktop/src/main/db/migrateToEncrypted.ts', "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nexport const k = JSON.parse(readFileSync(join('d', 'local-keys.json'), 'utf8')) as unknown"),
      at('packages/desktop/src/main/x.ts', "import { readFile } from 'node:fs/promises'\ndeclare const PREUNLOCK_FILE: string\nexport const p = await readFile(PREUNLOCK_FILE)"),
      at('packages/desktop/src/main/x.ts', "import * as fs from 'node:fs'\nexport const q = fs.readFileSync('quick-unlock.bin')"),
      // C1 re-review: the one-step variable form, the shape currentDb() itself had (a path in a const, then read).
      at('packages/desktop/src/main/db/x.ts', "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\ndeclare const dataDir: string, LOCAL_KEYS_FILE: string\nconst file = join(dataDir, LOCAL_KEYS_FILE)\nexport const k = readFileSync(file, 'utf8')"),
      at('packages/desktop/src/main/x.ts', "import { readFile } from 'node:fs/promises'\nimport { join } from 'node:path'\ndeclare const VAULT_FILE: string\nexport async function f(d: string) {\n  const p = join(d, VAULT_FILE)\n  return readFile(p)\n}"),
      at('packages/desktop/src/main/x.ts', "import * as fs from 'node:fs'\nconst q = 'quick-unlock.bin'\nexport const b = fs.readFileSync(q)"),
    ],
    good: [
      at('packages/desktop/src/main/index.ts', "import { readJsonCapped } from './vault/atomic'\ndeclare const VAULT_FILE: string\nexport const h = await readJsonCapped(VAULT_FILE)"),
      at('packages/desktop/src/main/x.ts', "import { existsSync, readFileSync } from 'node:fs'\ndeclare const VAULT_FILE: string\nexport const e = existsSync(VAULT_FILE)\nexport const l = readFileSync('app.log', 'utf8')"),
      at('packages/desktop/src/main/x.ts', "import { existsSync, readFileSync } from 'node:fs'\nimport { join } from 'node:path'\ndeclare const VAULT_FILE: string\nconst file = join('d', VAULT_FILE)\nconst log = join('d', 'app.log')\nexport const e = existsSync(file)\nexport const l = readFileSync(log, 'utf8')"),
    ],
  },
  'no-sync-safe-storage': {
    bad: [
      // C8 criterion 2: quick unlock's own synchronous calls (vault/quickUnlock.ts:51,81,105), no longer exempt.
      at('packages/desktop/src/main/vault/quickUnlock.ts', "import { safeStorage } from 'electron'\nexport const s = safeStorage.encryptString('x')"),
      { ...at('packages/desktop/src/main/vault/quickUnlock.ts', "declare const p: { safeStorage: { isEncryptionAvailable(): boolean } }\nexport const ok = p.safeStorage.isEncryptionAvailable()"), count: 1 },
      // audit F-EL-01: git credentials sealed with the synchronous API (sync/git/auth.ts:30).
      at('packages/desktop/src/main/sync/git/auth.ts', "import { writeFileSync } from 'node:fs'\ndeclare const storage: { encryptString(s: string): Buffer }, token: string\nwriteFileSync('t', storage.encryptString(token))"),
      at('packages/desktop/src/main/onenote/auth.ts', "import { safeStorage } from 'electron'\nexport const s = safeStorage.decryptString(Buffer.from('x'))"),
    ],
    good: [at('packages/desktop/src/main/secretStorage.ts', "import { safeStorage } from 'electron'\nexport const s = safeStorage.encryptStringAsync('x')")],
  },
  'secrets-through-secret-storage': {
    bad: [
      at('packages/desktop/src/main/onenote/auth.ts', "import { safeStorage as electronSafeStorage } from 'electron'\nexport const s = electronSafeStorage"),
      at('packages/desktop/src/main/index.ts', "import { safeStorage } from 'electron/main'\nexport const s = safeStorage"),
      at('packages/desktop/src/main/x.ts', "import * as electron from 'electron'\nexport const s = electron.safeStorage"),
    ],
    good: [
      at('packages/desktop/src/main/secretStorage.ts', "import { safeStorage } from 'electron'\nexport const s = safeStorage"),
      at('packages/desktop/src/main/index.ts', "import { appSecretStorage } from './secretStorage'\nexport const s = appSecretStorage()"),
    ],
  },
  'loads-in-the-factory': {
    bad: [
      // Review of C8: a main-initiated load skips will-navigate.
      at('packages/desktop/src/main/x.ts', "declare const win: { loadURL(u: string): Promise<void> }\nvoid win.loadURL('data:text/html,x')"),
      at('packages/desktop/src/main/x.ts', "declare const win: { webContents: { loadFile(p: string): Promise<void> } }\nvoid win.webContents.loadFile('/tmp/x.html')"),
    ],
    good: [at('packages/desktop/src/main/windows.ts', "declare const win: { loadURL(u: string): Promise<void> }\nvoid win.loadURL('app://slate/index.html')")],
  },
  'web-contents-guards-in-hardening': {
    bad: [
      at('packages/desktop/src/main/x.ts', "declare const wc: { on(e: string, f: () => void): void }\nwc.on(`will-navigate`, () => {})"),
      at('packages/desktop/src/main/x.ts', "declare const wc: { removeAllListeners(): void }\nwc.removeAllListeners()"),
      at('packages/desktop/src/main/windows.ts', "declare const win: { webContents: { setWindowOpenHandler(h: unknown): void } }\nwin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))"),
      at('packages/desktop/src/main/index.ts', "import { app } from 'electron'\napp.on('web-contents-created', () => {})"),
      at('packages/desktop/src/main/x.ts', "declare const wc: { removeAllListeners(e: string): void }\nwc.removeAllListeners('will-navigate')"),
      at('packages/desktop/src/main/x.ts', "import { session } from 'electron'\nsession.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true))"),
    ],
    good: [
      at('packages/desktop/src/main/hardening.ts', "import { app } from 'electron'\napp.on('web-contents-created', () => {})"),
      at('packages/desktop/src/main/x.ts', "import { app } from 'electron'\napp.on('before-quit', () => {})"),
    ],
  },
  'protocols-through-the-gate': {
    bad: [
      // Red team residual: protocol.handle in index.ts served data while locked with no gate.
      at('packages/desktop/src/main/index.ts', "import { protocol } from 'electron'\nprotocol.handle('x', () => new Response('notes'))"),
      at('packages/desktop/src/main/x.ts', "import { session } from 'electron'\nsession.defaultSession.protocol.handle('x', () => new Response(''))"),
      at('packages/desktop/src/main/x.ts', "import { protocol } from 'electron'\nprotocol.registerBufferProtocol('x', () => {})"),
    ],
    good: [
      at('packages/desktop/src/main/protocols.ts', "import { protocol } from 'electron'\nprotocol.handle('x', () => new Response(''))"),
      at('packages/desktop/src/main/index.ts', "import { protocol } from 'electron'\nprotocol.registerSchemesAsPrivileged([])"),
    ],
  },
  'parse-html-in-the-sanitiser': {
    bad: [
      // Red team R2: what the old message steered toward.
      { ...at('packages/desktop/src/renderer/src/x.ts', "export const d = new DOMParser().parseFromString('<b>', 'text/html')"), count: 2 },
      at('packages/editor/src/x.ts', "export const d = document.implementation.createHTMLDocument('')"),
    ],
    good: [at('packages/editor/src/clipboard.ts', "export const d = new DOMParser().parseFromString('<b>', 'text/html')")],
  },
  'secrets-out-of-react-state': {
    bad: [
      // The pre-C7 lock screen, migration banner and settings rows.
      { ...at('packages/desktop/src/renderer/src/lock/LockScreen.tsx', "import { useState } from 'react'\nexport function L() {\n  const [secret, setSecret] = useState('')\n  return <input type={'password'} value={secret} onChange={(e) => setSecret(e.target.value)} />\n}"), count: 2 },
      at('packages/desktop/src/renderer/src/x.tsx', "import React from 'react'\nexport function L() {\n  const [newPassword] = React.useState('')\n  return <p>{newPassword}</p>\n}"),
      { ...at('packages/desktop/src/renderer/src/x.tsx', "export const F = () => <input type=\"password\" data-testid=\"migration-password\" />"), count: 2 },
      // The pre-C7 wizard: the recovery key typed back into a plain textarea held in state as `typed`.
      at('packages/desktop/src/renderer/src/vault/EncryptWizard.tsx', "declare const typed: string\nexport const F = () => <textarea data-testid=\"recovery-confirm-input\" value={typed} />"),
      at('packages/desktop/src/renderer/src/x.tsx', "export const F = () => <input placeholder=\"Recovery key\" />"),
      // Review C7 L3: the sync token's exemption is its own file, not all of the sync settings.
      at('packages/desktop/src/renderer/src/sync/SyncSettings.tsx', "export const F = () => <input type=\"password\" />"),
    ],
    good: [
      at('packages/desktop/src/renderer/src/vault/SecretField.tsx', "export const F = (p: { kind: 'password' | 'text' }) => <input type={p.kind} />"),
      at('packages/desktop/src/renderer/src/x.tsx', "import { useState } from 'react'\nexport function L() {\n  const [typed, setTyped] = useState(false)\n  const [recoveryKey] = useState('')\n  return <input type=\"checkbox\" data-testid=\"quick-unlock-toggle\" checked={typed} onChange={() => setTyped(!typed)} title={recoveryKey} />\n}"),
      at('packages/desktop/src/main/x.tsx', "export const F = () => <input type=\"password\" />"),
      at('packages/desktop/src/renderer/src/sync/SyncTokenField.tsx', "export const F = () => <input type=\"password\" />"),
    ],
  },
  'sync-token-field-in-sync-settings': {
    bad: [
      // Re-review C7 L: the token field's exemption must not travel with the component into a vault dialog.
      at('packages/desktop/src/renderer/src/settings/sections/SecuritySection.tsx', "import { SyncTokenField } from '../../sync/SyncTokenField'"),
    ],
    good: [at('packages/desktop/src/renderer/src/sync/SyncSettings.tsx', "import { SyncTokenField } from './SyncTokenField'")],
  },
  'renderer-links-through-external-link': {
    bad: [
      { ...at('packages/desktop/src/renderer/src/x.ts', "declare const u: string\nconst a = document.createElement('a')\na.href = u\na.click()"), count: 2 },
      // Red team R1: ordinary JSX and location changes that took the window to a remote page.
      { ...at('packages/desktop/src/renderer/src/x.tsx', "declare const url: string\nexport const A = () => <a href={url} target=\"_blank\">x</a>"), count: 2 },
      at('packages/desktop/src/renderer/src/x.ts', "declare const url: string\nwindow.location.href = url"),
      at('packages/desktop/src/renderer/src/x.ts', "declare const url: string\nlocation.href = url"),
      at('packages/desktop/src/renderer/src/x.ts', "declare const url: string\nlocation.assign(url)"),
      at('packages/desktop/src/renderer/src/x.ts', "declare const url: string\nwindow.location = url as never"),
      at('packages/editor/src/x.ts', "declare const el: HTMLElement, url: string\nel.ownerDocument.defaultView!.open(url)"),
      at('packages/desktop/src/renderer/src/x.tsx', "export const F = () => <iframe src=\"x\" />"),
    ],
    good: [
      at('packages/desktop/src/renderer/src/ExternalLink.tsx', "declare const url: string\nexport const A = () => <a href={url}>x</a>"),
      at('packages/desktop/src/renderer/src/main.tsx', "export const locked = new URLSearchParams(location.search).has('lock')"),
      at('packages/desktop/src/renderer/src/x.tsx', "export const A = () => <a id=\"x\">x</a>"),
    ],
  },
  'log-through-logger': {
    bad: [
      at('packages/desktop/src/main/update/index.ts', 'export const log = (m: unknown) => console.error(m)'),
      at('packages/desktop/src/main/onenote/auth.ts', 'export const warn = console.warn'),
      // Red team 5b: an alias, a destructuring, globalThis, and stdout.
      at('packages/desktop/src/main/x.ts', "const { error: shout } = console\nshout('k')"),
      at('packages/desktop/src/main/x.ts', "const c = console\nc.log('k')"),
      at('packages/desktop/src/main/x.ts', "globalThis.console.log('k')"),
      at('packages/desktop/src/main/x.ts', "process.stdout.write('k')"),
      // Red team re-run R4: packages/sync runs in the main process too.
      at('packages/sync/src/gitDrive.ts', "declare const key: Buffer\nconsole.log('remote key', Buffer.from(key).toString('hex'))"),
      at('packages/importer/src/x.ts', "console.warn('x')"),
    ],
    good: [at('packages/desktop/src/main/log/logger.ts', "console.error('logger failed')"), at('packages/desktop/src/renderer/src/x.ts', "console.error('x')")],
  },
}

describe('slate/* table rules', () => {
  it('every rule has a bad and a good case', () => {
    const missing = SANCTIONED.map((d) => d.name).filter((name) => !CASES[name] || CASES[name].bad.length === 0 || CASES[name].good.length === 0)
    expect(missing).toEqual([])
  })

  it('every message names what to do instead (a path or an API), not only what is wrong', () => {
    for (const def of SANCTIONED) expect(def.message, def.name).toMatch(/`[^`]+`|src\/|docs\//)
  })

  for (const [name, { bad, good }] of Object.entries(CASES)) {
    const rule = plugin.rules?.[name]
    if (!rule) throw new Error(`no rule slate/${name}`)
    ruleTester().run(`slate/${name}`, /** @type {any} */ (rule), {
      valid: good,
      invalid: bad.map(({ count = 1, ...c }) => ({ ...c, errors: Array.from({ length: count }, () => ({ messageId: 'use' })) })),
    })
  }
})
