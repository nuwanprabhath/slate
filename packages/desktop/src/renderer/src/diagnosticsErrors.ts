import type { RendererErrorReport } from '../../shared/api'

/** Stack frames only: an error's message can quote what the user was working on. */
export function reportFor(kind: RendererErrorReport['kind'], error: unknown): RendererErrorReport {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const frames = stack.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, 12)
  return { kind, name: error instanceof Error ? error.name : typeof error, frames }
}

/** Forwards uncaught errors and unhandled rejections to the diagnostic log (a no-op while it is off). */
export function installErrorForwarding(): void {
  const send = (kind: RendererErrorReport['kind'], error: unknown) => {
    window.slate.diagnostics.rendererError(reportFor(kind, error)).catch(() => {})
  }
  window.addEventListener('error', (e) => send('error', e.error))
  window.addEventListener('unhandledrejection', (e) => send('unhandledrejection', e.reason))
}
