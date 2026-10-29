import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultProblem } from '../../shared/api'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { floorOf, isDowngrade, isNewerKeys, parseHeader, profileOf, verifyCheck, type VaultHeader } from './header'
import type { WeakKdfOption } from './kdf'
import type { KeyRing } from './keyring'
import { casWriteHeader, sameHeader, type VaultRemote } from './remoteVault'
import { readSeen, writeSeen } from './seen'
import { CANDIDATE_FILE, PENDING_FILE, SYNCED_FILE, VAULT_FILE } from './unlock'
import { securityEvent } from '../log/securityEvents'

const MESSAGES: Record<VaultProblem, string> = {
  'join-needed': 'Your notes are now encrypted on another device. Enter your password to keep syncing.',
  'other-vault': 'This sync folder is encrypted with a different password. Join it, or choose another sync folder.',
  'not-encrypted': 'This sync folder is not encrypted.',
  'keys-changed': 'Your vault’s keys were changed on another device. Enter your password to keep syncing.',
}

/** Stops a sync run before anything is uploaded; the renderer offers what to do about it. */
export class VaultSyncProblem extends Error {
  override name = 'VaultSyncProblem'
  constructor(readonly problem: VaultProblem) {
    super(MESSAGES[problem])
  }
}

async function readHeader(path: string, opts: WeakKdfOption): Promise<VaultHeader | null> {
  try {
    return parseHeader(await readJsonCapped(path), opts)
  } catch {
    return null
  }
}

/** §4: a later header of this vault waits as the pending one, never replacing a later pending one. */
async function writePending(dataDir: string, theirs: VaultHeader, local: VaultHeader, opts: WeakKdfOption): Promise<void> {
  const pending = await readHeader(join(dataDir, PENDING_FILE), opts)
  if (!pending || pending.vaultId !== local.vaultId || pending.revision < theirs.revision) await writeJsonAtomic(join(dataDir, PENDING_FILE), theirs)
}

/**
 * §7.3: runs before every sync upload (the engine's `beforeUpload`). Throws `VaultSyncProblem`
 * when this device must not write to the remote as it is; otherwise returns and the run goes on.
 */
export async function checkRemoteVault(ctx: { remote: VaultRemote; dataDir: string; keyRing: KeyRing | null; opts: WeakKdfOption }): Promise<void> {
  const { remote, dataDir, keyRing, opts } = ctx
  const snap = await remote.read()
  if (!keyRing) {
    if (snap.header !== null) throw new VaultSyncProblem('join-needed')
    return
  }
  const local = await readHeader(join(dataDir, VAULT_FILE), opts)
  if (!local) throw new Error('This device’s vault file is missing or damaged')
  if (snap.header === null) {
    if (snap.otherFiles.length > 0) throw new VaultSyncProblem('not-encrypted')
    // An empty remote: ours from the start. Losing the swap means someone else wrote; the next run looks again.
    if (!(await casWriteHeader(remote, snap, null, local))) throw new Error('The sync folder changed while Slate set it up; trying again')
    await writeSeen(dataDir, local)
    return
  }
  let theirs: VaultHeader
  try {
    theirs = parseHeader(snap.header, opts)
  } catch {
    // Roadmap §3.5: a header this build cannot read (a newer format, or damage) is recorded, and never written over.
    const version = (snap.header as { version?: unknown } | null)?.version
    securityEvent.headerRefused({ reason: 'schema', ...(typeof version === 'number' ? { headerVersion: version } : {}) }, 'sync')
    throw new Error('The vault file in the sync folder is damaged; Slate will not sync to it')
  }
  if (theirs.vaultId !== local.vaultId) throw new VaultSyncProblem('other-vault')
  // Review C9 M4: this vault is synced; a key change made with sync off would fork it, so it is refused from now on.
  if (!existsSync(join(dataDir, SYNCED_FILE))) await writeJsonAtomic(join(dataDir, SYNCED_FILE), { vaultId: local.vaultId })
  // Audit §4.5.2: a header-v1 copy of a vault that has moved to v2, or a weaker profile, is never adopted, and
  // nothing is written over it either: sync stops until someone looks (T-POL-05).
  if (isDowngrade(theirs, floorOf(local))) {
    securityEvent.headerRefused({ reason: 'downgrade', headerVersion: theirs.version, profile: profileOf(theirs) }, 'sync')
    // Review C9 L2/M4/M5: a header of an earlier key epoch is refused. It goes back to this device's header only over the
    // exact header this device last saw there (compare-and-swap): another device's change made before it saw this
    // device's key change cannot be told from a retired key's replay, so sync stops and asks instead.
    const seen = await readSeen(dataDir, opts)
    if (!isDowngrade(theirs, { ...floorOf(local), keyEpoch: undefined }) && (await casWriteHeader(remote, snap, seen, local))) await writeSeen(dataDir, local)
    throw new Error('The vault file in the sync folder is older or weaker than this device’s; Slate will not sync to it')
  }
  // The ring's handle: valid until the ring closes, and never destroyed here.
  const mk = keyRing.get('mk')
  if (theirs.revision > local.revision && !verifyCheck(theirs, mk) && isNewerKeys(theirs, local)) {
    // C9: another device rotated (or upgraded, or converted) the vault. Nothing more goes out under the old keys. Review
    // C9 L1: unverified, the header is only the candidate, replaced by whatever the remote holds next; only a secret
    // that verifies its `check` at unlock ever adopts it (criterion 3).
    await writeJsonAtomic(join(dataDir, CANDIDATE_FILE), theirs)
    throw new VaultSyncProblem('keys-changed')
  }
  if (sameHeader(snap.header, local)) {
    await writeSeen(dataDir, local)
  } else if (theirs.revision > local.revision && verifyCheck(theirs, mk)) {
    // §4: never adopted silently; the lock screen tries it after the local header.
    await writePending(dataDir, theirs, local, opts)
    await writeSeen(dataDir, theirs)
  } else if (theirs.revision === local.revision && verifyCheck(theirs, mk)) {
    // Review C9 M5: another device changed the password at the same time and published first. Its header wins; this
    // device's change is not written over it, and sync waits until its password (the pending header) opens the vault.
    await writePending(dataDir, theirs, local, opts)
    throw new VaultSyncProblem('keys-changed')
  } else if (theirs.revision < local.revision && verifyCheck(local, mk)) {
    // A change made here while offline goes out by the same compare-and-swap as any header write: only over the header
    // this device last saw there (or, in a folder from an older build that recorded none, over the remote's own one).
    const seen = (await readSeen(dataDir, opts)) ?? theirs
    if (await casWriteHeader(remote, snap, seen, local)) await writeSeen(dataDir, local)
  }
}
