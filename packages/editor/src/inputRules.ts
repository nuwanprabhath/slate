/**
 * Which TipTap input and paste rules a box editor runs (CLAUDE.md, Product rules: no auto-formatting
 * by default). The one place this is decided; packages/editor/test/spec/inputRules.test.ts pins it.
 */
export function editorRuleOptions(settings: { markdownShortcuts: boolean; autoBullets: boolean }): { enableInputRules: boolean | string[]; enablePasteRules: false } {
  return {
    enableInputRules: settings.markdownShortcuts ? true : settings.autoBullets ? ['autoBullets'] : false,
    enablePasteRules: false,
  }
}
