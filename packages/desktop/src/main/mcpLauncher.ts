import { posix, win32 } from 'node:path'

export interface LauncherInfo {
  command: string
  claudeCommand: string
  packaged: boolean
}

/** Where an AI agent finds Slate's MCP server: the launcher shipped in the app, or bin/slate-mcp in a checkout. */
export function launcherInfo(opts: { packaged: boolean; resourcesPath: string; repoRoot: string; platform: NodeJS.Platform }): LauncherInfo {
  const path = opts.platform === 'win32' ? win32 : posix
  const command = opts.packaged
    ? path.join(opts.resourcesPath, 'bin', opts.platform === 'win32' ? 'slate-mcp.cmd' : 'slate-mcp')
    : posix.join(opts.repoRoot, 'bin', 'slate-mcp')
  return { command, claudeCommand: `claude mcp add slate -- "${command}"`, packaged: opts.packaged }
}
