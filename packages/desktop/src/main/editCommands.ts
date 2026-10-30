import type { EditCommand } from '../shared/api'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'

const COMMANDS: readonly EditCommand[] = ['cut', 'copy', 'paste']

const isEditCommand = (value: unknown): value is EditCommand => typeof value === 'string' && (COMMANDS as readonly string[]).includes(value)

/**
 * The text menu's Cut, Copy and Paste. Main runs them on the window that asked, as the Edit menu's
 * roles do, so the page gets the same clipboard event as for the keystroke: the editor's own copy and
 * paste run (images stored, links made) and a page cannot read the clipboard any other way through it.
 */
export function registerEditIpc(ipc: IpcRegistrar): void {
  ipc.handle(CH.editCommand, (e, command: unknown) => {
    if (!isEditCommand(command)) throw new Error('Refused an unknown edit command')
    e.sender[command]()
  })
}
