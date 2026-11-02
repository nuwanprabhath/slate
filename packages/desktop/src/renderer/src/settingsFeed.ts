import type { Settings, SlateApi } from '../../shared/api'

/**
 * Keeps `apply` on the latest settings: the first read, then every change main announces. The read and
 * the announcements reach the page by different routes, so a change made while the read is still in
 * flight (a menu toggle in the first moments after launch) can arrive first; the read, older than it,
 * must not then overwrite it. Returns the unsubscribe, after which nothing is applied, not even a read
 * still in flight (React's StrictMode runs an effect twice in development).
 */
export function followSettings(api: Pick<SlateApi['settings'], 'get' | 'onChange'>, apply: (settings: Settings) => void): () => void {
  let changed = false
  let stopped = false
  void api.get().then((settings) => {
    if (!changed && !stopped) apply(settings)
  })
  const off = api.onChange((settings) => {
    changed = true
    apply(settings)
  })
  return () => {
    stopped = true
    off()
  }
}
