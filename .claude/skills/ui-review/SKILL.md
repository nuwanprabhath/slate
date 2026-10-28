---
name: ui-review
description: The UI quality gate for Slate — designing a UI change before it is built, the UI scenarios and audit every renderer change passes, and the screenshot review that decides whether it is good enough to ship. Use when building, delegating or reviewing anything a person sees (the lock screen, a settings section, a banner, a dialog, the library, the toolbar), and before saying a UI change is done.
---

# UI review

Functional tests prove a feature works; they never noticed it looked broken. Slate 0.2.0 shipped
these with every test green, and the maintainer found each by hand:

- the lock screen's "Unlock with Touch ID" button left of the card's centre, narrower than Unlock;
- Settings → Security → Change password: fields running into each other, their help text drawn
  over them, the "The same password again" placeholder cut;
- Settings → Diagnostics: "Nothing written yet." squeezed onto three lines at the right;
- the vault banner's "Enter password…" cut at the top of the window, over the title bar.

The audit built for them then found more: one long section name pushing the page out of an 800 px
window, buttons in the browser's grey default, Dark's primary buttons at 2.7:1 contrast.

This skill is the gate that catches them before the maintainer does. It has three layers, cheapest
first.

## 1. Machine checks (every run, no judgment)

- **The UI audit** (`packages/desktop/e2e/ui/audit.ts`) runs in the real app window on every UI
  scenario, at each theme and width. Each rule is a yes/no "is this broken?":
  - `clipped-text`: a label cut by its box, unless its full text is in a tooltip and 5em still shows;
  - `cut-off`: part of a control hidden by its container or the window;
  - `overlap`: two controls, or two texts, drawn over each other (line by line, a field by its
    content box);
  - `see-through-popup`: a menu, dialog, find bar or tooltip the page shows through;
  - `native-control`: a button or field with the browser's default look;
  - `list-marker`: bullets in app chrome;
  - `misaligned-row`: controls side by side, or in a `role="toolbar"`, off one centre line;
  - `low-contrast`: text under 3:1 against its background;
  - `unnamed-control`: an icon-only control with no name;
  - `placeholder-clipped`: a field's placeholder wider than the field;
  - `crowded`: two boxed controls less than 4px apart, side by side or stacked;
  - `off-centre`: in a centred column, a narrower control off the centre line; in a left-aligned
    column, one neither on its siblings' edge nor centred;
  - `squeezed-text`: a short text (six words or fewer) wrapped onto three or more lines.
- **The Stop hook** (`.claude/hooks/definition-of-done.mjs` with `uiReview.mjs`, tested in
  `tools/guards/uiReview.test.ts`):
  - a branch that changes `packages/desktop/src/renderer/**/*.{tsx,css}` adds or changes a UI
    scenario (or says why in `No-UI-Review-Reason:`);
  - a new `data-ui-allow` needs a `UI-Allow-Reason:` trailer;
  - a change to `audit.ts` or `review.ts` needs a `UI-Gate-Change:` trailer.

An element that legitimately breaks a rule carries `data-ui-allow="<rule>: <reason>"` (reason of 8
characters or more), for example the window title, which truncates while the page and notebook
names show in full in the library. That is rare, and the lead reviews each one.

## 2. UI scenarios and screenshots (every UI change)

- A scenario is a Playwright spec in `packages/desktop/e2e/ui/<feature>.ui.spec.ts` that reaches a
  state and calls `reviewUi(app, page, name, { open, close, widths, themes, within, scroll })`
  (`packages/desktop/e2e/ui/review.ts`). They run in the normal `npm run e2e`, so CI runs them.
- `reviewUi` runs in Dark, Light, Paper and Glass, at 800 px (the narrow window) and 1280 px (a new
  window's size). For each it applies the theme the way the app does, sizes the window, runs `open`,
  audits, and saves `ui-review/shots/<name>--<theme>-<width>.png`. With `scroll: '<pane selector>'`
  it pages through a scrolling pane, auditing and saving each screenful (`…-p2.png`), so nothing
  below the fold escapes. Violations are reported with the screenshot they are in.
- Getting there: `e2e/ui/states.ts` has an encrypted vault locked or unlocked (`lockedApp`,
  `unlockedApp`), and `stubInvoke`/`sendEvent` to have main answer a channel or send an event the
  way it would after a real sync, Touch ID or a broken migration. The renderer under review is the
  real one; only main's answer is canned.
- **Cover the states a person reaches, not just the resting one:** each menu open, each banner,
  each wizard step, the narrow window, long names, empty, busy and error states, every settings
  section (the settings scenario walks the registry by its nav, so a new section is covered).
- **A failing audit is fixed in the UI, never by changing the scenario.** Do not drop a width or a
  theme, shorten the text or move the state until the audit passes. A defect that is not yours goes
  in your report with its screenshot; the scenario stays where it showed it.
- **A reported visual bug is reproduced before it is fixed.** First a scenario whose audit fails on
  what the maintainer saw, plus an assertion on that symptom where the audit is not specific (the
  Touch ID button's width and left edge equal Unlock's; the banner starts below the title bar; with
  both library columns collapsed the pane is just the two rails). Then fix it, and see the same
  scenario pass.
- `npm run ui:review` builds, runs only the UI scenarios and writes `ui-review/index.html`: every
  screenshot on one page, stamped with the commit. Pass a scenario file to run only that one.
  The root `/ui-review/` folder is not committed.

## 3. The lead's review (judgment, on the screenshots)

Never accept a UI change from its report or its tests. Open `ui-review/index.html`, or read the
PNGs, and go through this list for every state:

1. **Nothing is broken.** No text cut mid-word, no half-drawn control, no overlap, no bullets, no
   grey default control, no popup the page shows through, no control floating off its row.
2. **It belongs to this app.**
   - It uses the existing pieces: `.btn` (`.primary`, `.danger`), `.settings-stack`,
     `.settings-field`, `.settings-actions`, `.settings-help`, `.settings-indent`, `.vault-field`,
     `.settings-group`, `.lock-unlock`/`.lock-secondary`, `.context-menu`, the tokens in `app.css`.
   - Its corner radius, padding, font size and colours match its neighbours.
   - Nothing is new where an existing pattern fits.
3. **It survives narrow and light.** At 800 px and in Light and Paper it still reads well; Glass
   surfaces are opaque where text sits on them. Something degrades on purpose (wraps, truncates
   with a tooltip), never by being cut.
4. **The hierarchy is clear.** The primary action is obvious, secondary text is muted and under its
   control, related things are grouped and aligned on one edge, help under a checkbox sits on the
   label's edge.
5. **States are designed.** Empty, busy, error and a long value each look intended.
6. **It matches the design spec** the lead wrote (below), or the deviation is better and explained.

Write each finding as the state, the screenshot, what is wrong and what it should be. Send the
findings back to the agent; on the second failed round, fix it yourself or narrow the brief.

**Check that new files are tracked.** Before calling a branch done, the agent runs
`git status --ignored` and the lead checks that every new file is in the diff. This skill was once
lost: a `.gitignore` line meant for the screenshot folder (`ui-review/`) also matched
`.claude/skills/ui-review/`, so the file existed only on one disk while CLAUDE.md and the Stop hook
pointed at it. `tools/guards/uiReview.test.ts` now fails if a skill CLAUDE.md names is not tracked.

## Designing before delegating

Agents build UI well from a precise spec and poorly from "make it good". For any UI work, the lead
writes the spec into the brief:

- **Where it lives and what it reuses.** The component, the existing class to build on, the tokens.
- **A mockup per state.** ASCII is fine:

  ```text
  Change password
    Current password
    [______________]
    Forgot it? Use the recovery key
    New password
    [______________]
    Type it again
    [______________]
    At least 10 characters…   (muted)
    [Change password]
  ```

  Include the sizes that matter (field width 320 px, gaps 4 px within a field and 10 px between).
- **Behaviour at 800 px.** What wraps, truncates or hides, in priority order.
- **Each theme's concern.** Glass needs an opaque surface under text; Light and Paper need contrast.
- **The UI scenarios to write,** by name and state. These are the acceptance criteria, together
  with the functional tests.
