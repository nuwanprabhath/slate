/** Lets Settings → Security open the dialogs that live outside the Settings dialog. */
const WIZARD = 'slate:encrypt-wizard'
const JOIN = 'slate:vault-join'

export const openEncryptWizard = () => window.dispatchEvent(new Event(WIZARD))
export const openJoinDialog = () => window.dispatchEvent(new Event(JOIN))

function on(name: string, handler: () => void): () => void {
  window.addEventListener(name, handler)
  return () => window.removeEventListener(name, handler)
}
export const onOpenEncryptWizard = (handler: () => void) => on(WIZARD, handler)
export const onOpenJoinDialog = (handler: () => void) => on(JOIN, handler)

/** IPC errors arrive wrapped in Electron's "Error invoking remote method" prefix. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}
