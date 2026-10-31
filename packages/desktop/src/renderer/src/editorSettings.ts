import type { EditorServices } from '@slate/editor'

type EditorSettings = Pick<EditorServices, 'markdownShortcuts' | 'autoBullets'>

let current: EditorSettings | null = null

/**
 * The settings box editors are being made with, once React has committed them. A setting changes
 * in main first and reaches the renderer a moment later: e2e waits here before typing into a new box.
 */
export const editorSettings = {
  get: (): EditorSettings | null => current,
  set: (services: EditorSettings): void => {
    current = { markdownShortcuts: services.markdownShortcuts, autoBullets: services.autoBullets }
  },
}
