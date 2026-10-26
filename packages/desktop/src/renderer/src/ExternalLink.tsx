import type { ReactNode } from 'react'

/**
 * The one way the renderer shows a link to the outside (lint rule
 * `slate/renderer-links-through-external-link`): a click hands the URL to main, which opens https and
 * mailto in the user's browser (`openExternalSafe`). The window itself never follows it, and main's
 * navigation guards (src/main/hardening.ts) cancel it if it tried: a remote page in a Slate window
 * would get the preload (audit B-1).
 */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault()
        void window.slate.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}
