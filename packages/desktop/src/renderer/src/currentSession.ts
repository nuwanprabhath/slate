import { useEffect, useState } from 'react'
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

const reloadListeners = new Set<(pageId: string) => void>()

/**
 * Asks the page view showing `pageId` to mount again, with a fresh session: after its stored history was
 * replaced (erase history, GDPR-04), the open editor's doc and undo stack still hold the text the erase removed.
 */
export const pageReload = {
  request: (pageId: string): void => {
    for (const listener of reloadListeners) listener(pageId)
  },
  subscribe: (listener: (pageId: string) => void): (() => void) => {
    reloadListeners.add(listener)
    return () => {
      reloadListeners.delete(listener)
    }
  },
}

/** How many reloads `pageId` has had: part of its page view's key, so a reload mounts the view anew. */
export function usePageReloads(pageId: string | null): number {
  const [count, setCount] = useState(0)
  useEffect(
    () =>
      pageReload.subscribe((id) => {
        if (id === pageId) setCount((n) => n + 1)
      }),
    [pageId],
  )
  return count
}
