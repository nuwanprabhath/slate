import { envSnapshot } from './testHooks'
import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const APP_NAME = 'Slate'

/** The app and the MCP CLI must agree on this folder: it holds slate.db. */
export function defaultUserDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = envSnapshot(), home: string = homedir()): string {
  if (env.SLATE_USER_DATA) return env.SLATE_USER_DATA
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME)
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_NAME)
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_NAME)
}

/** Phase 1 builds stored data under the package name; move it once into the Slate folder. */
export function migrateLegacyUserData(newDir: string): boolean {
  const legacy = join(dirname(newDir), '@slate', 'desktop')
  if (existsSync(join(newDir, 'slate.db')) || !existsSync(join(legacy, 'slate.db'))) return false
  if (existsSync(newDir)) return false
  renameSync(legacy, newDir)
  return true
}
