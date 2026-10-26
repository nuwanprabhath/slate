import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** sun_path is 104 bytes on macOS (108 on Linux), terminator included. */
export const MAX_SOCKET_PATH_BYTES = 100

export interface SocketEnv {
  tmpdir: string
  uid: number
  /** `$XDG_RUNTIME_DIR` on Linux: per-user and private, so preferred over the shared temp dir. */
  runtimeDir?: string
}

/** The app and the `slate-mcp` proxy must compute the same path, so both build it from this. */
export function socketEnv(from: { platform: string; env: Record<string, string | undefined>; tmpdir: string; uid: number }): SocketEnv {
  const runtimeDir = from.platform === 'linux' ? from.env.XDG_RUNTIME_DIR : undefined
  return { tmpdir: from.tmpdir, uid: from.uid, ...(runtimeDir ? { runtimeDir } : {}) }
}

/** §9: in the data folder when it fits, else a private folder under the runtime or temp dir. */
export function mcpSocketPath(userData: string, env: SocketEnv): string {
  const inData = join(userData, 'mcp.sock')
  if (Buffer.byteLength(inData, 'utf8') <= MAX_SOCKET_PATH_BYTES) return inData
  return join(env.runtimeDir ?? env.tmpdir, `slate-${env.uid}`, 'mcp.sock')
}

/**
 * A socket folder outside the data folder must be a real directory we own with no group/other
 * bits; otherwise a same-named trap set by another user is refused (by the app, and by the proxy
 * before it sends anything there).
 */
export function checkSocketDir(socketPath: string, userData: string, uid: number): void {
  const dir = join(socketPath, '..')
  if (dir === userData) return
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`)
  if (st.uid !== uid) throw new Error(`${dir} is owned by someone else`)
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is readable by other users`)
}

/** Makes the socket's folder private: the data folder is chmod 0700; a temp folder is created 0700 and checked. */
export function prepareSocketDir(socketPath: string, userData: string, uid: number): void {
  chmodSync(userData, 0o700)
  if (join(socketPath, '..') === userData) return
  mkdirSync(join(socketPath, '..'), { recursive: true, mode: 0o700 })
  checkSocketDir(socketPath, userData, uid)
}
