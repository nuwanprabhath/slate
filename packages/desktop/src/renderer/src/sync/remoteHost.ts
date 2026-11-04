/** Whether a git remote is hosted on GitHub: its host, from a URL or the scp form `user@host:path`. */
export function isGitHubRemote(remote: string): boolean {
  // The scp form, user@ optional; a host has a dot, so a URL scheme (https:) or a drive letter is not one.
  const scp = /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):(?!\/\/)/.exec(remote)
  if (scp) return scp[1]!.toLowerCase() === 'github.com'
  try {
    return new URL(remote).hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}
