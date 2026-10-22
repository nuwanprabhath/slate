type Listener = (section?: string) => void
const listeners = new Set<Listener>()

/** Opens the Settings dialog from inside the renderer, as the `show-settings` menu command does from main. */
export function openSettings(section?: string): void {
  listeners.forEach((l) => l(section))
}

export function onOpenSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
