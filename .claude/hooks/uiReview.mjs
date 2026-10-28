// The UI part of the definition of done (definition-of-done.mjs), pure so tools/guards/uiReview.test.ts
// can run it. Slate 0.2.0 shipped a Touch ID button off the lock card's centre, a change-password
// form whose fields ran into each other, a squeezed Diagnostics status and banners cut by the window
// edge, every test green. So a renderer change is looked at, not only tested: (1) its states are in a
// UI scenario (packages/desktop/e2e/ui/*.ui.spec.ts, `reviewUi`), whose screenshots the lead reviews
// and whose audit runs in `npm run e2e`; (2) an audit exception (`data-ui-allow`) does not appear
// without a reason a reviewer reads; (3) the audit itself does not move without one.

export const RENDERER_UI = /^packages\/desktop\/src\/renderer\/.*\.(tsx|css)$/
export const UI_SCENARIO = /^packages\/desktop\/e2e\/ui\/.*\.ui\.spec\.ts$/
export const UI_GATE = /^packages\/desktop\/e2e\/ui\/(audit|review)\.ts$/

/**
 * @param {{ changed: string[], trailer: (key: string) => string, allowNow: number, allowBase: number }} branch
 *   `changed`: files changed since the base; `trailer`: a commit trailer's values on the branch;
 *   `allowNow`/`allowBase`: `data-ui-allow` occurrences in the renderer now and at the base.
 * @returns {string[]} one problem per failed rule
 */
export function uiReviewProblems({ changed, trailer, allowNow, allowBase }) {
  const problems = []
  const ui = changed.filter((f) => RENDERER_UI.test(f))
  const scenarios = changed.filter((f) => UI_SCENARIO.test(f))
  if (ui.length > 0 && scenarios.length === 0 && trailer('No-UI-Review-Reason') === '') {
    problems.push(
      `── no UI scenario ──\nThis branch changes ${String(ui.length)} renderer file(s) (${ui.slice(0, 4).join(', ')}${ui.length > 4 ? ', …' : ''}) and no UI scenario.\nAdd or extend packages/desktop/e2e/ui/<feature>.ui.spec.ts: open each state you built (menus open, narrow window, long text, error) and call reviewUi (see .claude/skills/ui-review/SKILL.md). Run \`npm run ui:review\` and look at your screenshots. If nothing visible changed, say why in a commit trailer: \`No-UI-Review-Reason: <why>\`.`,
    )
  }
  if (allowNow > allowBase && trailer('UI-Allow-Reason') === '') {
    problems.push(
      `── UI audit exception added ──\nThis branch adds a data-ui-allow. Fix the layout instead; if the element truly must break the rule (a title that truncates with its full text elsewhere), say why in a commit trailer: \`UI-Allow-Reason: <element, rule, why>\`.`,
    )
  }
  const gate = changed.filter((f) => UI_GATE.test(f))
  if (gate.length > 0 && trailer('UI-Gate-Change') === '') {
    problems.push(
      `── UI audit changed ──\n${gate.join(', ')} changed in this branch. The audit is the lead's: never weaken or tune it to pass. A false positive goes in your report (or say why in a \`UI-Gate-Change:\` trailer).`,
    )
  }
  return problems
}
