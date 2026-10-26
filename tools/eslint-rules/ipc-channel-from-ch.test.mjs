// @ts-check
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'

const rule = /** @type {any} */ (plugin.rules?.['ipc-channel-from-ch'])
const MAIN = 'packages/desktop/src/main/x.ts'
const PRELOAD = 'packages/desktop/src/preload/index.ts'

ruleTester().run('slate/ipc-channel-from-ch', rule, {
  valid: [
    at(MAIN, "import { CH } from '../shared/ipc'\ndeclare const ipc: { handle(c: string, h: () => void): void }\nipc.handle(CH.docsList, () => {})"),
    at(PRELOAD, "import { ipcRenderer } from 'electron'\nimport { CH } from '../shared/ipc'\nvoid ipcRenderer.invoke(CH.docsLoad, 'id')\nipcRenderer.send(CH.vaultLock)"),
    // The registrar and its log wrapper forward the channel they were handed.
    at('packages/desktop/src/main/ipcGuard.ts', "declare const raw: { handle(c: string, h: () => void): void }, channel: string\nraw.handle(channel, () => {})\ndeclare const ipc: { handle(c: string, h: () => void): void }\nipc.handle(channel, () => {})"),
    // An e2e spec talks to the window with literal channel names; it is not app code.
    at('packages/desktop/e2e/settings.spec.ts', "declare const ipcRenderer: { send(c: string): void }\nipcRenderer.send('menu:command')"),
  ],
  invalid: [
    {
      // settings.spec.ts:40 sends `'menu:command'` as a string; in app code that channel would escape CHANNEL_POLICY.
      ...at(MAIN, "declare const ipc: { handle(c: string, h: () => void): void }\nipc.handle('menu:command', () => {})"),
      errors: [{ messageId: 'member' }],
    },
    {
      ...at(MAIN, "declare const ipcMain: { on(c: string, h: () => void): void }, channel: string\nipcMain.on(channel, () => {})"),
      errors: [{ messageId: 'member' }],
    },
    {
      ...at(PRELOAD, "import { ipcRenderer } from 'electron'\nvoid ipcRenderer.invoke('docs:load', 'id')"),
      errors: [{ messageId: 'member' }],
    },
    {
      ...at(PRELOAD, "import { ipcRenderer } from 'electron'\nimport { CH } from '../shared/ipc'\ndeclare const k: keyof typeof CH\nipcRenderer.send(CH[k])"),
      errors: [{ messageId: 'member' }],
    },
  ],
})
