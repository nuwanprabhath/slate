/** The short form of the last-synced time shown beside the toolbar icon; empty when never synced. */
export function syncAgeText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString()
}
