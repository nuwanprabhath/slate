// @ts-check
import { allowlist, matchesAny, repoPath, resolveImport } from './paths.mjs'
import { MAIN_PROCESS, SANCTIONED } from './sanctioned.mjs'
import envThroughTestHooks from './env-through-test-hooks.mjs'
import ipcChannelFromCh from './ipc-channel-from-ch.mjs'
import keyBytesStayPut from './key-bytes-stay-put.mjs'
import secretBytesStayBytes from './secret-bytes-stay-bytes.mjs'
import skipNeedsReason from './skip-needs-reason.mjs'
import testsRegisteredUnconditionally from './tests-registered-unconditionally.mjs'
import sqlTextIsLiteral from './sql-text-is-literal.mjs'
import noKeyText from './no-key-text.mjs'

/**
 * The `slate/*` ESLint rules: "there is one sanctioned way to do X here", one rule per X.
 *
 * A local plugin rather than `no-restricted-imports`/`no-restricted-syntax` blocks, because a later
 * flat-config block that sets the same rule for the same files replaces the earlier options instead
 * of merging them, silently dropping an allowlist. Here every rule carries its own scope (`files`,
 * `ignores`) and sanctioned homes (`allow`), so one config block turns them all on.
 */

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const TESTS = ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'packages/*/test/**', 'packages/*/e2e/**', 'packages/*/e2e-packaged/**']

/**
 * Rules with their own module (logic a selector cannot express), scoped like the table's.
 * @type {readonly { name: string, rule: RuleModule, files: readonly string[], ignores?: readonly string[], allow?: readonly string[] }[]}
 */
export const CUSTOM = [
  {
    name: 'ipc-channel-from-ch',
    rule: ipcChannelFromCh,
    files: ['packages/desktop/src/main/**/*.ts', 'packages/desktop/src/preload/**/*.ts'],
    ignores: TESTS,
    // The registrar itself and its logging wrapper pass the channel they were given through.
    allow: ['packages/desktop/src/main/ipcGuard.ts', 'packages/desktop/src/main/log/ipcLog.ts'],
  },
  {
    name: 'env-through-test-hooks',
    rule: envThroughTestHooks,
    files: MAIN_PROCESS,
    ignores: [...TESTS, 'packages/desktop/src/main/testSetup.ts'],
    allow: ['packages/desktop/src/main/testHooks.ts', 'packages/sync/src/childEnv.ts'],
  },
  {
    name: 'sql-text-is-literal',
    rule: sqlTextIsLiteral,
    files: MAIN_PROCESS,
    ignores: TESTS,
    allow: Object.keys(allowlist('sql-dynamic')),
  },
  {
    name: 'no-key-text',
    rule: noKeyText,
    files: MAIN_PROCESS,
    ignores: TESTS,
  },
  {
    name: 'key-bytes-stay-put',
    rule: keyBytesStayPut,
    files: ['packages/desktop/src/main/**/*.ts'],
    ignores: TESTS,
    allow: Object.keys(allowlist('key-copies')),
  },
  {
    // Review C7 L2: a typed secret never becomes text; checkPassword (vault/password.ts) is the one residual.
    name: 'secret-bytes-stay-bytes',
    rule: secretBytesStayBytes,
    files: ['packages/desktop/src/{main,preload,renderer,shared}/**/*.{ts,tsx}'],
    ignores: TESTS,
    allow: ['packages/desktop/src/main/vault/password.ts'],
  },
  {
    name: 'skip-needs-reason',
    rule: skipNeedsReason,
    files: TESTS,
  },
  {
    name: 'tests-registered-unconditionally',
    rule: testsRegisteredUnconditionally,
    files: TESTS,
  },
]

/** Wraps a rule so it runs only in its files, outside its ignores and sanctioned homes. */
function scoped(/** @type {RuleModule} */ rule, /** @type {{ files: readonly string[], ignores?: readonly string[], allow?: readonly string[] }} */ scope) {
  return /** @type {RuleModule} */ ({
    meta: rule.meta,
    create(context) {
      const file = repoPath(context.filename)
      if (!matchesAny(file, scope.files) || matchesAny(file, scope.ignores) || matchesAny(file, scope.allow)) return {}
      return rule.create(context)
    },
  })
}

/** @param {readonly (string | RegExp)[] | undefined} list */
const toRegExps = (list) => (list ?? []).map((s) => (typeof s === 'string' ? new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) : s))

/** @param {import('./sanctioned.mjs').Sanctioned} def @returns {RuleModule} */
function makeRule(def) {
  /** @type {RuleModule} */
  const rule = {
    meta: { type: 'problem', docs: { description: def.description }, messages: { use: def.message }, schema: [] },
    create(context) {
      const report = (/** @type {any} */ node) => context.report({ node, messageId: 'use' })
      if (def.kind === 'syntax') {
        /** @type {Record<string, (node: any) => void>} */
        const handlers = Object.fromEntries(def.selectors.map((s) => [s, report]))
        const follow = def.followConst
        if (follow) {
          // One step of data flow: an argument that is a const whose initializer names what the selectors name.
          handlers.CallExpression = (/** @type {any} */ node) => {
            const callee = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee
            if (callee?.type !== 'Identifier' || !follow.calls.test(callee.name)) return
            for (const arg of node.arguments) {
              if (arg.type !== 'Identifier') continue
              /** @type {any} */
              let scope = context.sourceCode.getScope(node)
              let variable = null
              while (scope && !variable) {
                variable = scope.set.get(arg.name) ?? null
                scope = scope.upper
              }
              const decl = variable?.defs[0]?.node
              if (decl?.type === 'VariableDeclarator' && decl.parent?.kind === 'const' && decl.init && follow.init.test(context.sourceCode.getText(decl.init))) report(node)
            }
          }
        }
        return handlers
      }

      const file = repoPath(context.filename)
      const sources = toRegExps(def.sources)
      const except = toRegExps(def.except)
      /** @param {string} source */
      const banned = (source) => {
        const landing = resolveImport(file, source)
        const inside = (/** @type {readonly string[] | undefined} */ dirs) => landing !== null && (dirs ?? []).some((d) => landing === d || landing.startsWith(`${d}/`))
        if (except.some((re) => re.test(source)) || inside(def.exceptInto)) return false
        return sources.some((re) => re.test(source)) || inside(def.into)
      }
      /** @param {any} node @param {any} sourceNode @param {boolean} typeOnly */
      const check = (node, sourceNode, typeOnly) => {
        const source = sourceNode?.value
        if (typeof source !== 'string' || !banned(source)) return
        if (def.allowTypeImports && typeOnly) return
        // A file allowed some names (crypto-imports.json): any other name, or a namespace, is an error.
        const allowedHere = def.allowNames?.[file]
        if (!def.importNames && !allowedHere) return report(node)
        if (node.type !== 'ImportDeclaration') return report(node)
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') {
            report(spec)
            continue
          }
          const name = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)
          if (allowedHere) {
            if (!allowedHere.includes(name)) report(spec)
            continue
          }
          if (def.importNames?.includes(name) && !(def.allowTypeImports && spec.importKind === 'type')) report(spec)
        }
      }
      return {
        ImportDeclaration: (node) => {
          const n = /** @type {any} */ (node)
          check(n, n.source, n.importKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every((/** @type {any} */ s) => s.importKind === 'type')))
        },
        ExportNamedDeclaration: (node) => check(node, node.source, /** @type {any} */ (node).exportKind === 'type'),
        ExportAllDeclaration: (node) => check(node, node.source, /** @type {any} */ (node).exportKind === 'type'),
        ImportExpression: (node) => check(node, node.source, false),
        'CallExpression[callee.name="require"]': (/** @type {any} */ node) => check(node, node.arguments[0], false),
      }
    },
  }
  return scoped(rule, def)
}

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'eslint-plugin-slate' },
  rules: {
    ...Object.fromEntries(SANCTIONED.map((def) => [def.name, makeRule(def)])),
    ...Object.fromEntries(CUSTOM.map((c) => [c.name, scoped(c.rule, c)])),
  },
}

/** Every rule name, without the `slate/` prefix. */
export const RULE_NAMES = [...SANCTIONED.map((d) => d.name), ...CUSTOM.map((c) => c.name)]

/** Every rule on, as errors: the scoping is inside each rule. */
export const slateRules = Object.fromEntries(RULE_NAMES.map((name) => [`slate/${name}`, 'error']))

export default plugin
