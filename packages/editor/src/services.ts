import { createContext, useContext } from 'react'

/** What box editors need from the host app. */
export interface EditorServices {
  putBlob(bytes: Uint8Array, mime: string): Promise<string>
  copyImage(url: string): Promise<boolean>
  readClipboardText(): Promise<string>
  markdownShortcuts: boolean
}

export const EditorServicesContext = createContext<EditorServices | null>(null)

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext)
  if (!services) throw new Error('EditorServicesContext is missing')
  return services
}
