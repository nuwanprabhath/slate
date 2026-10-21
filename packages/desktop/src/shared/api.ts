export interface Settings {
  /** When true, typing "1. ", "- ", "# " or "```" turns into lists/headings/code. Off by default. */
  markdownShortcuts: boolean
}

export const DEFAULT_SETTINGS: Settings = { markdownShortcuts: false }

export type MenuCommand =
  | { cmd: 'undo' }
  | { cmd: 'redo' }
  | { cmd: 'paste-plain' }
  | { cmd: 'settings-changed'; settings: Settings }

export interface SlateApi {
  isE2E: boolean
  docs: {
    list(prefix: string): Promise<string[]>
    load(docId: string): Promise<Uint8Array[]>
    append(docId: string, update: Uint8Array): Promise<void>
    remove(docId: string): Promise<void>
  }
  blobs: {
    put(bytes: Uint8Array, mime: string): Promise<string>
    copyImage(url: string): Promise<boolean>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  clipboardText(): Promise<string>
  onMenu(handler: (command: MenuCommand) => void): () => void
}
