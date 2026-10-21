import type { PageSession } from '@slate/editor'

let current: PageSession | null = null

/** The page session on screen; menu commands (undo/redo) act on it. */
export const currentSession = {
  get: (): PageSession | null => current,
  set: (session: PageSession): void => {
    current = session
  },
  clear: (session: PageSession): void => {
    if (current === session) current = null
  },
}
