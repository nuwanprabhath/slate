import type { PMJSON } from '@slate/core'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { currentSession } from './currentSession'
import { UpdatesSection } from './settings/sections/UpdatesSection'
import { pageOpenTiming } from './PageView'

const p = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** Installed only when SLATE_E2E=1: lets e2e tests seed large pages and read timings. */
export function installTestHooks(): void {
  ;(window as unknown as { slateTest: unknown }).slateTest = {
    seedBoxes(n: number): void {
      const session = currentSession.get()
      if (!session) throw new Error('No page open')
      for (let i = 0; i < n; i++) {
        session.createBoxWithContent(40 + (i % 2) * 520, 40 + Math.floor(i / 2) * 150, [
          p(`Box ${i}: deploy notes`),
          p('kubectl rollout status deploy/api --timeout=120s'),
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [p('check logs')] },
              { type: 'listItem', content: [p('verify metrics')] },
            ],
          },
        ])
      }
    },
    lastPageOpenMs: (): number | null => pageOpenTiming.lastMs,
    showUpdatesSection,
  }
  // Until the Settings dialog hosts the section, the banner's "Update settings" shows it here.
  window.addEventListener('slate:show-settings', showUpdatesSection)
}

/** A stand-in overlay so e2e can exercise UpdatesSection before the Settings dialog mounts it. */
function showUpdatesSection(): void {
  if (document.getElementById('slate-test-updates')) return
  const host = document.createElement('div')
  host.id = 'slate-test-updates'
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;padding:16px;background:var(--panel-2,#fff);border:1px solid var(--border,#ccc)'
  document.body.append(host)
  createRoot(host).render(createElement(UpdatesSection))
}
