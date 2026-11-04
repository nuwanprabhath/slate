/** Whether a git remote is hosted on GitHub: its host, from a URL or the scp form `user@host:path`. */
export function isGitHubRemote(remote: string): boolean {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/.exec(remote)
  if (scp) return scp[1]!.toLowerCase() === 'github.com'
  try {
    return new URL(remote).hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}
