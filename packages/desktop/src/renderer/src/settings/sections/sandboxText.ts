import type { VaultStatus } from '../../../../shared/api'
import { SANDBOX_FIPS_REFUSAL, SANDBOX_LOCK_NOTE, SANDBOX_NOTICE_BODY, SANDBOX_NOTICE_TITLE } from '../../../../shared/sandboxNotice'

type Sandbox = Pick<VaultStatus, 'rendererUnsandboxed'>

/** POAM-16: Settings → Security's notice while Slate runs without Chromium's renderer sandbox (the AppImage). */
export function settingsSandboxNotice(status: Sandbox, dismissed: boolean): { title: string; body: string } | null {
  if (!status.rendererUnsandboxed || dismissed) return null
  return { title: SANDBOX_NOTICE_TITLE, body: SANDBOX_NOTICE_BODY }
}

/**
 * The lock screen's line for the same case. A fips-140-3 vault will not unlock at all here (C5), so it is told
 * the whole refusal rather than a warning: the unlock button stays live, and this says why it cannot work.
 */
export function lockSandboxNote(status: Sandbox & Pick<VaultStatus, 'profile'>): string | null {
  if (!status.rendererUnsandboxed) return null
  return status.profile === 'fips-140-3' ? SANDBOX_FIPS_REFUSAL : SANDBOX_LOCK_NOTE
}
