// @ts-check
import { defineConfig, eslintComments, globalIgnores, globals, reactHooks, tseslint, vitest } from './tools/lint/index.mjs'
import slate, { slateRules } from './tools/eslint-rules/plugin.mjs'

/**
 * One config for the whole repo. The rules that matter most are `slate/*` (tools/eslint-rules/):
 * each names the one sanctioned way to do something and fires everywhere else. The table in
 * CLAUDE.md ("Guardrails") pairs each rule with what enforces it.
 *
 * Violations older than a rule live in eslint-suppressions.json, which only shrinks
 * (tools/guards/ratchet.test.ts). Never add to it to get past a check: fix the code.
 *
 * Type-aware for TypeScript: packages/core and packages/editor are linted under their own
 * tsconfig (no Node types; core also no DOM), everything else under the root one.
 */
// The per-edit hook (.claude/hooks/lint-edited.mjs) sets SLATE_LINT_FAST=1 to lint one file without type
// information, in about a second; npm run lint, lint:changed and the Stop hook are always typed.
const fast = process.env.SLATE_LINT_FAST === '1'

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/out/',
    '**/dist/',
    '**/release/',
    '**/test-results/',
    '**/playwright-report/',
    '.agent-reports/',
    '.claude/worktrees/',
    '.worktrees/',
    '.tools/',
    'packages/desktop/resources/',
    'packages/desktop/build/',
    'packages/desktop/launchers/',
    'tools/eslint-rules/fixtures/',
  ]),

  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project: ['./packages/core/tsconfig.json', './packages/editor/tsconfig.json', './tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 11. Type escape hatches. An `any` or a ts-ignore turns the checker off exactly where it was
      // needed; a floating promise is how an IPC failure disappears without a trace.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false, minimumDescriptionLength: 10 }],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // React event props take `() => void`; an async handler there is fine as long as nothing awaits it.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  },
  ...(fast ? [{ files: ['**/*.{ts,tsx}'], ...tseslint.configs.disableTypeChecked }] : []),
  {
    files: ['packages/desktop/src/main/vault/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },

  // Plain JavaScript (tools, hooks, scripts, configs): no types to check against.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node, ecmaVersion: 'latest', sourceType: 'module' },
  },

  // The `slate/*` rules and the disable-comment rules, everywhere. Each slate rule scopes itself.
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { slate, '@eslint-community/eslint-comments': eslintComments },
    linterOptions: { reportUnusedDisableDirectives: fast ? 'off' : 'error' },
    rules: {
      ...slateRules,
      // 13. A disable says why (`-- <reason>`), names its rule, and cannot switch off a guard rule:
      // an agent must not be able to write its way past a security check.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      // Only line disables (with a reason, above): no /* eslint rule: off */ config comments, /* global */,
      // /* eslint-env */ or block disables, which switch rules off for a whole file.
      '@eslint-community/eslint-comments/no-use': ['error', { allow: ['eslint-disable-next-line', 'eslint-disable-line'] }],
      '@eslint-community/eslint-comments/no-unused-disable': fast ? 'off' : 'error',
      '@eslint-community/eslint-comments/no-restricted-disable': ['error', 'slate/*', 'no-restricted-imports', 'no-restricted-syntax', 'no-restricted-globals', '@typescript-eslint/ban-ts-comment', '@eslint-community/eslint-comments/*'],
      'no-control-regex': 'error',
    },
  },

  // Renderer code (the app UI and the editor): React's two hook rules.
  {
    files: ['packages/desktop/src/renderer/**/*.{ts,tsx}', 'packages/editor/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // 12. Tests: `.only` silently skips every other test; `.skip`/`.todo` say why (slate/skip-needs-reason).
  {
    files: ['**/*.test.{ts,tsx,mjs}', '**/*.spec.ts', 'packages/*/test/**/*.{ts,tsx}', 'packages/*/e2e/**/*.ts', 'packages/*/e2e-packaged/**/*.ts'],
    plugins: { vitest },
    rules: { 'vitest/no-focused-tests': ['error', { fixable: false }] },
  },
])
