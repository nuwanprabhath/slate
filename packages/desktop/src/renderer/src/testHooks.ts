import type { PMJSON } from '@slate/core'
import { currentSession } from './currentSession'
import { editorSettings } from './editorSettings'
import { pageOpenTiming } from './PageView'
import { askConsent } from './privacy/askConsent'
import { isConsentFeature } from '../../shared/privacy/consent'

const p = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** What e2e specs call on `window.slateTest`, installed only when SLATE_E2E=1. */
export interface SlateTestHooks {
  /** One box with the given content on the open page (screenshots and content-shape tests). */
  addBox(x: number, y: number, blocks: PMJSON[], width?: number): string
  seedBoxes(n: number): void
  lastPageOpenMs(): number | null
  /** The Markdown Shortcuts and Auto Bullets settings a new box editor gets now. */
  editorSettings(): ReturnType<typeof editorSettings.get>
  /** The first-run privacy card stays hidden for every spec that does not ask for it (a fresh profile would show it over the app). */
  firstRunPrivacy: boolean
  showFirstRunPrivacy(): void
  /** The last answer from `askConsent` started here: true granted, false declined, 'alternative', null while open. */
  consentResult: boolean | 'alternative' | null
  /** Opens the consent step for `feature` as a section would; with `alternative`, that label is the main action. */
  askConsent(feature: string, alternative?: string): void
}

declare global {
  interface Window {
    /** Only under SLATE_E2E=1, and only this file reads or writes it (`slate/renderer-test-hooks-in-one-file`). */
    slateTest?: SlateTestHooks
  }
}

/** The e2e hook asks the first-run card to look again (`showFirstRunPrivacy`). */
export const FIRST_RUN_RECHECK = 'slate:first-run-recheck'

/** Whether e2e hooks keep the first-run privacy card hidden: they are installed, and the spec did not ask for the card. */
export function firstRunSuppressedForTests(): boolean {
  const hooks = window.slateTest
  return hooks !== undefined && !hooks.firstRunPrivacy
}

/** Installed only when SLATE_E2E=1: lets e2e tests seed large pages and read timings. */
export function installTestHooks(): void {
  const hooks: SlateTestHooks = {
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
    lastPageOpenMs: () => pageOpenTiming.lastMs,
    editorSettings: () => editorSettings.get(),
    firstRunPrivacy: false,
    showFirstRunPrivacy(): void {
      hooks.firstRunPrivacy = true
      window.dispatchEvent(new Event(FIRST_RUN_RECHECK))
    },
    consentResult: null,
    askConsent(feature: string, alternative?: string): void {
      if (!isConsentFeature(feature)) throw new Error(`not a consent feature: ${feature}`)
      hooks.consentResult = null
      void askConsent(feature, alternative ? { label: alternative, onClick: () => {} } : undefined).then((a) => {
        hooks.consentResult = a === 'granted' ? true : a === 'declined' ? false : 'alternative'
      })
    },
  }
  window.slateTest = hooks
}
