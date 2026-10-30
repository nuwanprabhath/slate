import { createContext, useContext } from 'react'

/** What box editors need from the host app. */
export interface EditorServices {
  putBlob(bytes: Uint8Array, mime: string): Promise<string>
  copyImage(url: string): Promise<boolean>
  /** Puts a selection with pictures on the clipboard; main embeds the image bytes. */
  copyRich(text: string, html: string): Promise<void>
  readClipboardText(): Promise<string>
  /** Runs Cut, Copy or Paste on the window as the Edit menu does, so the editor gets the real clipboard event. */
  editCommand(command: 'cut' | 'copy' | 'paste'): Promise<void>
  markdownShortcuts: boolean
  autoBullets: boolean
  /** Pasted web and mail addresses become links. */
  linkPastedUrls: boolean
  /** Misspelled words are underlined; nothing is ever corrected. */
  spellcheckUnderline: boolean
  /** Opens a link in the system browser; the renderer never navigates itself. */
  openExternal(url: string): Promise<void>
}

export const EditorServicesContext = createContext<EditorServices | null>(null)

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext)
  if (!services) throw new Error('EditorServicesContext is missing')
  return services
}
