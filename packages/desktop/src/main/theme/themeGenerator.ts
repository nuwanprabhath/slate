import { buildThemePrompt, extractThemeJson, THEME_JSON_SCHEMA } from '../../shared/theme/prompt'
import type { ThemeGenerateResult } from '../../shared/theme/resolve'
import type { ThemeSpec } from '../../shared/theme/spec'
import { describeReport, validateTheme } from '../../shared/theme/validate'

export interface ThemeRunRequest {
  prompt: string
  jsonSchema: object
  timeoutMs: number
}

/** Runs one `claude -p` (claudeOneShot.ts), or a canned reply under E2E. */
export interface ThemeRunner {
  readonly busy: boolean
  /** Resolves with claude's stdout; rejects with a message fit to show. */
  run(req: ThemeRunRequest): Promise<string>
  cancel(): void
}

/**
 * Asks the user's own `claude` to design a theme. Whatever comes back is only ever passed on
 * through `validateTheme`, here in main, before the renderer sees it.
 */
export class ThemeGenerator {
  constructor(private readonly opts: { runner: ThemeRunner; timeoutMs?: number }) {}

  cancel(): void {
    this.opts.runner.cancel()
  }

  async generate(req: { request: string; current: ThemeSpec | null }): Promise<ThemeGenerateResult> {
    if (this.opts.runner.busy) throw new Error('Already generating a theme.')
    const request = typeof req.request === 'string' ? req.request.trim() : ''
    if (request === '') throw new Error('Describe the theme you would like.')
    // A refinement's "current" comes from the renderer, so it is validated like anything else.
    const current = req.current === null ? null : validateTheme(req.current).spec
    const stdout = await this.opts.runner.run({
      prompt: buildThemePrompt({ request, current }),
      jsonSchema: THEME_JSON_SCHEMA,
      // Apiary measured 45–55 s for a full theme on Sonnet, so 90 s was too close.
      timeoutMs: this.opts.timeoutMs ?? 150_000,
    })
    const raw = extractThemeJson(stdout)
    if (raw === null) throw new Error("Claude's reply had no theme in it. Try describing it differently.")
    const { spec, report } = validateTheme(raw)
    return { spec, note: describeReport(report) }
  }
}

/** The E2E stand-in (`SLATE_FAKE_CLAUDE_THEME=1`): a canned forest theme, so tests never run the real CLI. */
export function fakeThemeRunner(): ThemeRunner {
  let busy = false
  return {
    get busy() { return busy },
    async run() {
      busy = true
      await new Promise((r) => setTimeout(r, 300))
      busy = false
      return JSON.stringify({
        structured_output: {
          name: 'Calm Forest',
          palette: { 'bg': '#16241cff', 'page': '#1b2b22ff', 'panel': '#213428ff', 'toolbar-bg': '#1e3025ff', 'sidebar-bg': '#1e3025ff', 'popover': '#243a2cff', 'text': '#e3efe6ff', 'muted': '#9db5a5ff', 'accent': '#7fcf9aff', 'border': '#2d4636ff' },
          material: 'solid', texture: 'none', font: 'system', effects: [],
        },
      })
    },
    cancel() { busy = false },
  }
}
