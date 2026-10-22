import type { PMJSON } from '@slate/core'
import { currentSession } from './currentSession'
import { pageOpenTiming } from './PageView'

const p = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** Installed only when SLATE_E2E=1: lets e2e tests seed large pages and read timings. */
export function installTestHooks(): void {
  ;(window as unknown as { slateTest: unknown }).slateTest = {
    /** One box with the given content on the open page (screenshots and content-shape tests). */
    addBox(x: number, y: number, blocks: PMJSON[], width?: number): string {
      const session = currentSession.get()
      if (!session) throw new Error('No page open')
      return session.createBoxWithContent(x, y, blocks, width)
    },
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
  }
}

