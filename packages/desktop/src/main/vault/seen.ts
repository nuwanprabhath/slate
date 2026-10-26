// Review C9 M5: the remote header this device last read and verified (or wrote). Every remote header write is a true
// compare-and-swap against it: the write goes through only if the remote still holds exactly this header, so a change
// another device made meanwhile is never written over, whatever its revision or epoch.
import { join } from 'node:path'
import { readJsonCapped, writeJsonAtomic } from './atomic'
import { parseHeader, type VaultHeader } from './header'
import type { WeakKdfOption } from './kdf'

export const SEEN_FILE = 'vault.seen.json'

export async function readSeen(dataDir: string, opts: WeakKdfOption = {}): Promise<VaultHeader | null> {
  try {
    return parseHeader(await readJsonCapped(join(dataDir, SEEN_FILE)), opts)
  } catch {
    return null
  }
}

export async function writeSeen(dataDir: string, header: VaultHeader): Promise<void> {
  await writeJsonAtomic(join(dataDir, SEEN_FILE), header)
}
