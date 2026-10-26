/** Pointer and wheel input reach the main process's idle timer at most this often. */
const ACTIVITY_THROTTLE_MS = 5000

/**
 * The app page's side of the vault lock: tells the main process about input it cannot see
 * (keys it sees itself), about copies it may clear at lock, and writes pending edits when asked.
 */
export function installVaultRelay(): void {
  const vault = window.slate.vault
  let last = 0
  const activity = () => {
    const now = Date.now()
    if (now - last < ACTIVITY_THROTTLE_MS) return
    last = now
    vault.activity()
  }
  window.addEventListener('pointerdown', activity, { capture: true, passive: true })
  window.addEventListener('wheel', activity, { capture: true, passive: true })
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = window.slate.chrome.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!mod || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'l') return
      e.preventDefault()
      vault.lock()
    },
    { capture: true },
  )
  document.addEventListener('copy', () => vault.copied(), { capture: true })
  document.addEventListener('cut', () => vault.copied(), { capture: true })
  vault.onFlush(async () => {
    // Blurring ends the editor's composition and commits its pending transaction; the resulting
    // appends are sent before this resolves, so they reach the main process ahead of the reply.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await new Promise((r) => setTimeout(r, 0))
  })
}
