/**
 * The privacy channels (GDPR review §3.1 step 6-7): consent grants and withdrawals, which A implements
 * here against the settings, and the data-rights and retention backends (workstreams E and D). Every
 * channel is `unlocked`: nothing here is served while an encrypted vault is locked.
 */
import type { PrivacyStatus } from '../../shared/api'
import { CH } from '../../shared/ipc'
import { isConsentFeature, isDocId, isEraseConfirmation, isPurgeScope, refuse } from '../../shared/ipcValidators'
import { CONSENT_FEATURES, DISCLOSURES, egressAllowed, type ConsentFeature, type Consents } from '../../shared/privacy/consent'
import type { IpcRegistrar } from '../ipcGuard'
import { readSettings, writeSettings } from '../settings'
import type { DocStore } from '../store'
import type { ProfileId } from '../vault/profile'
import type { DataRights } from './dataRights'
import type { Retention } from './retention'

export interface ConsentOps {
  status(): PrivacyStatus
  grant(feature: ConsentFeature): PrivacyStatus
  revoke(feature: ConsentFeature): PrivacyStatus
}

export interface PrivacyDeps extends ConsentOps {
  dataRights: DataRights
  retention: Retention
  /** `services().sync`; C replaces the `forget` stub. */
  sync: () => { forget(): Promise<void> }
}

/** Grants and withdrawals as settings writes, so every `onSettingsWritten` listener (the update schedule) sees them. */
export function createConsents(deps: { store: () => DocStore; profile: () => ProfileId | null; now?: () => number }): ConsentOps {
  const now = deps.now ?? Date.now
  const status = (): PrivacyStatus => {
    const s = readSettings(deps.store())
    return {
      gdprStrictMode: s.gdprStrictMode,
      consents: s.consents,
      allowed: Object.fromEntries(CONSENT_FEATURES.map((f) => [f, egressAllowed(s, f)])) as Record<ConsentFeature, boolean>,
      legacy: CONSENT_FEATURES.filter((f) => s.consents[f]?.source === 'legacy'),
      profile: deps.profile(),
    }
  }
  const write = (consents: Consents): PrivacyStatus => {
    writeSettings(deps.store(), { consents })
    return status()
  }
  return {
    status,
    grant: (f) => write({ ...readSettings(deps.store()).consents, [f]: { grantedAt: now(), textVersion: DISCLOSURES[f].textVersion, source: 'user' } }),
    revoke: (f) => {
      const { [f]: _gone, ...rest } = readSettings(deps.store()).consents
      return write(rest)
    },
  }
}

export function registerPrivacyIpc(ipc: IpcRegistrar, deps: PrivacyDeps): void {
  ipc.handle(CH.privacyStatus, () => deps.status())
  ipc.handle(CH.privacyGrant, (_e, feature: unknown) => {
    if (!isConsentFeature(feature)) refuse(CH.privacyGrant)
    return deps.grant(feature)
  })
  ipc.handle(CH.privacyRevoke, (_e, feature: unknown) => {
    if (!isConsentFeature(feature)) refuse(CH.privacyRevoke)
    return deps.revoke(feature)
  })
  ipc.handle(CH.privacyExport, () => deps.dataRights.exportAll())
  ipc.handle(CH.privacyPurge, (_e, scope: unknown) => {
    if (!isPurgeScope(scope)) refuse(CH.privacyPurge)
    return deps.retention.purge(scope)
  })
  ipc.handle(CH.privacyEraseHistory, (_e, docId: unknown) => {
    if (!isDocId(docId)) refuse(CH.privacyEraseHistory)
    return deps.dataRights.eraseHistory(docId)
  })
  ipc.handle(CH.privacyEraseAll, (_e, confirm: unknown) => {
    if (!isEraseConfirmation(confirm)) refuse(CH.privacyEraseAll)
    return deps.dataRights.eraseAll()
  })
  ipc.handle(CH.privacySecurityLogRead, () => deps.retention.readSecurityLog())
  ipc.handle(CH.privacySecurityLogClear, () => deps.retention.clearSecurityLog())
  ipc.handle(CH.auditClear, () => deps.retention.clearAudit())
  ipc.handle(CH.syncForget, () => deps.sync().forget())
}
