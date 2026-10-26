import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { canonicalRecoveryText } from './recovery'

/** The real path of `path`, resolving symlinks in whatever part of it exists. */
function real(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(real(parent), basename(abs))
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** §7.1 step 5: a recovery key saved next to the notes it unlocks protects nothing. Null when fine. */
export function refuseRecoveryPath(path: string, dataDir: string): string | null {
  if (inside(real(path), real(dataDir))) return 'Save your recovery key outside Slate’s data folder, for example on a USB stick, or print it.'
  return null
}

/** The save dialog's options; `message` shows in the macOS sheet. */
export function recoverySaveDialog(documentsDir: string): { defaultPath: string; message: string; filters: Array<{ name: string; extensions: string[] }> } {
  return {
    defaultPath: join(documentsDir, 'Slate recovery key.txt'),
    message:
      'Documents may sync to iCloud or another cloud drive, putting the key next to your notes. Printing it or keeping it in a password manager is safer.',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  }
}

/** The saved file's text; only a well-formed recovery key is ever written. */
export function recoveryFileText(recoveryKey: string): string {
  const key = canonicalRecoveryText(recoveryKey)
  return [
    'Slate recovery key',
    '',
    key,
    '',
    'With this key you can open your encrypted Slate notes if you forget your password.',
    'Keep it somewhere safe and away from this computer. Anyone who has it and a copy of your',
    'notes can read them.',
    '',
  ].join('\n')
}
