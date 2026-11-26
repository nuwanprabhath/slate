import type { PMJSON } from '@slate/core'
import { currentSession } from './currentSession'
import { editorSettings } from './editorSettings'
import { pageOpenTiming } from './PageView'
import { askConsent } from './privacy/askConsent'
import { FIRST_RUN_RECHECK } from './privacy/FirstRunPrivacy'
import { isConsentFeature } from '../../shared/privacy/consent'

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
    /** The Markdown Shortcuts and Auto Bullets settings a new box editor gets now. */
    editorSettings: () => editorSettings.get(),
    /** The first-run privacy card stays hidden for every spec that does not ask for it (a fresh profile would show it over the app). */
    firstRunPrivacy: false,
    showFirstRunPrivacy(): void {
      ;(window as unknown as { slateTest: { firstRunPrivacy: boolean } }).slateTest.firstRunPrivacy = true
      window.dispatchEvent(new Event(FIRST_RUN_RECHECK))
    },
    /** The last answer from `askConsent` started here: true granted, false declined, 'alternative', null while open. */
    consentResult: null as boolean | 'alternative' | null,
    /** Opens the consent step for `feature` as a section would; with `alternative`, that label is the main action. */
    askConsent(feature: string, alternative?: string): void {
      if (!isConsentFeature(feature)) throw new Error(`not a consent feature: ${feature}`)
      const hooks = (window as unknown as { slateTest: { consentResult: boolean | 'alternative' | null } }).slateTest
      hooks.consentResult = null
      void askConsent(feature, alternative ? { label: alternative, onClick: () => {} } : undefined).then((a) => {
        hooks.consentResult = a === 'granted' ? true : a === 'declined' ? false : 'alternative'
      })
    },
  }
}

