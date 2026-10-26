import type { VaultStatus } from '../../../../shared/api'

type Sandbox = Pick<VaultStatus, 'rendererUnsandboxed'>

/** POAM-16: Settings → Security's notice while Slate runs without Chromium's renderer sandbox (the AppImage). */
export function settingsSandboxNotice(status: Sandbox, dismissed: boolean): { title: string; body: string } | null {
  if (!status.rendererUnsandboxed || dismissed) return null
  return {
    title: "Slate is running without Chromium's sandbox",
    body:
      'Its windows, the lock screen included, are not isolated from the rest of your session: other programs running as you can read their memory, ' +
      'such as a password you type to unlock. This is how the AppImage runs on most current Linux systems. Install the .deb package to run Slate in the sandbox.',
  }
}

/** The lock screen's one small line for the same case. */
export function lockSandboxNote(status: Sandbox): string | null {
  return status.rendererUnsandboxed ? "Running without Chromium's sandbox: other programs running as you can read what you type here. The .deb package runs sandboxed." : null
}
