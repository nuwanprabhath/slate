import type { EditCommand } from '../shared/api'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'

const COMMANDS: readonly EditCommand[] = ['cut', 'copy', 'paste']

const isEditCommand = (value: unknown): value is EditCommand => typeof value === 'string' && (COMMANDS as readonly string[]).includes(value)

// Mouse presses only: a page can make the pointer move or the wheel turn reach it, never a press it did
// not get. Key presses do not count: the text menu has no keyboard path, and every keystroke in a note
// would otherwise open a window for the page to paste the rich clipboard into itself.
const PRESSES: ReadonlySet<string> = new Set(['mouseDown', 'mouseUp'])

/** How long after a person's mouse press on a window it may still ask main for a clipboard command. */
export const USER_INPUT_WINDOW_MS = 1000

/**
 * The last press of a real mouse button on each window, from Electron's `input-event`, which
 * only input from the OS (or the e2e driver) raises; a page's synthetic DOM events never do.
 */
export class UserInputClock {
  private readonly last = new WeakMap<object, number>()
  constructor(private readonly now: () => number = Date.now) {}

  note(contents: object, type: string): void {
    if (PRESSES.has(type)) this.last.set(contents, this.now())
  }

  recent(contents: object, withinMs = USER_INPUT_WINDOW_MS): boolean {
    const at = this.last.get(contents)
    return at !== undefined && this.now() - at <= withinMs
  }
}

/**
 * The text menu's Cut, Copy and Paste. Main runs them on the window that asked, as the Edit menu's
 * roles do, so the editor gets the same trusted clipboard event as for the keystroke. That paste
 * event carries the whole clipboard (HTML, image files), which a page cannot otherwise read, so each
 * command needs a person's mouse press on that window within the last second: a compromised page cannot
 * paste the clipboard into itself unasked.
 */
export function registerEditIpc(ipc: IpcRegistrar, input: UserInputClock): void {
  ipc.handle(CH.editCommand, (e, command: unknown) => {
    if (!isEditCommand(command)) throw new Error('Refused an unknown edit command')
    if (!input.recent(e.sender)) throw new Error('Refused an edit command with no recent user input on its window')
    e.sender[command]()
  })
}
