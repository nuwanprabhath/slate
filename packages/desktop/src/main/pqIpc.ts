// Post-quantum readiness channels (phase 14). `vault` is the header upgrade's state (PQ-B3).
import type { PqReadiness, TransportObservation } from '../shared/api'
import { CH } from '../shared/ipc'
import type { IpcRegistrar } from './ipcGuard'
import { services, servicesOpen } from './services'
import { HYBRID_ALG, PINNED_UPDATE_KEYS, requiresPq } from './update/signature'
import { pqVaultReadiness } from './vault/pqUpgrade'

/** What the sync service knows of its transports (PQ-C4); null while the notes are closed. */
export interface PqTransportSource {
  transports(): TransportObservation[]
  checkTransport(): Promise<TransportObservation[]>
  requirePq(): boolean
  plaintextSync(): boolean
}

const openSync = (): PqTransportSource | null => (servicesOpen() ? services().sync : null)

const noArgs = (channel: string, args: unknown[]): void => {
  if (args.length) throw new Error(`${channel} takes no arguments`)
}

export function registerPqIpc(ipc: IpcRegistrar, sync: () => PqTransportSource | null = openSync): void {
  ipc.handle(CH.vaultPqReadiness, (_e, ...args): PqReadiness => {
    noArgs(CH.vaultPqReadiness, args)
    const source = sync()
    return { atRest: 'symmetric-256', vault: pqVaultReadiness(), transports: source?.transports() ?? [], updateSignature: requiresPq(PINNED_UPDATE_KEYS) ? HYBRID_ALG : 'ed25519', plaintextSync: source?.plaintextSync() ?? false, requirePq: source?.requirePq() ?? false }
  })
  // The renderer only asks; the probe itself runs here, in main, and only while the notes are open.
  ipc.handle(CH.syncCheckTransport, async (_e, ...args): Promise<TransportObservation[]> => {
    noArgs(CH.syncCheckTransport, args)
    return (await sync()?.checkTransport()) ?? []
  })
}
