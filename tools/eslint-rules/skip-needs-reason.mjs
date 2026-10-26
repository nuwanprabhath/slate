// @ts-check

/**
 * `slate/skip-needs-reason`: a skipped, conditional or todo test says why on the line above. A bare `.skip` is
 * how a failing test quietly stops running; with a reason, a reviewer can tell whether it still holds.
 * `runIf(c)` is `skipIf(!c)` and needs one too (C11). Every form is seen, called or not: `it.skip(…)`,
 * `it.skip.each(…)(…)`, and a modifier taken as a value (`const maybe = linux ? it : it.skip`).
 * (`.only` is `vitest/no-focused-tests`.)
 */
import { runnerNames } from './tests-registered-unconditionally.mjs'

/** The runner names of the file being linted, imported aliases included (set at Program). */
let RUNNERS = new Set(['it', 'test', 'describe'])
const MODIFIERS = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fixme'])

/** The identifier a chain starts from: `it` for `it.skip.each([…])` and `test.describe.skip`. */
function rootOf(/** @type {any} */ node) {
  let n = node
  while (n && (n.type === 'MemberExpression' || n.type === 'CallExpression')) n = n.type === 'MemberExpression' ? n.object : n.callee
  return n
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Skipped, conditional and todo tests carry a reason comment on the line above.' },
    messages: {
      reason: 'Say why this test is `{{modifier}}` in a comment on the line above (what it waits for, or which work package adds it), or make it run.',
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    /** A comment on the line above `node`'s line, or right before it. */
    const hasReason = (/** @type {any} */ node) => {
      const line = node.loc?.start.line ?? 0
      if (source.getAllComments().some((c) => c.loc && c.loc.end.line === line - 1)) return true
      const before = source.getTokenBefore(node, { includeComments: true })
      return before?.type === 'Line' || before?.type === 'Block'
    }
    return {
      Program(node) {
        RUNNERS = runnerNames(node)
      },
      MemberExpression(node) {
        const n = /** @type {any} */ (node)
        // `it.skip` and `it['skip']` alike.
        const name = !n.computed && n.property.type === 'Identifier' ? n.property.name : n.computed && n.property.type === 'Literal' ? n.property.value : null
        if (typeof name !== 'string' || !MODIFIERS.has(name)) return
        const root = rootOf(n.object)
        if (root?.type !== 'Identifier' || !RUNNERS.has(root.name)) return
        const call = n.parent?.type === 'CallExpression' && n.parent.callee === n ? n.parent : null
        if (call) {
          // Playwright's `test.skip(condition, 'why')` carries its reason as the second argument.
          const second = call.arguments[1]
          if (second?.type === 'Literal' && typeof second.value === 'string' && second.value.trim() !== '') return
          if (second?.type === 'TemplateLiteral') return
          // `it.todo('… (C4)')` names the work package that adds it in its own title.
          if (name === 'todo' && call.arguments[0]?.type === 'Literal' && /\((C\d+|G\d+)[^)]*\)/.test(String(call.arguments[0].value))) return
        }
        if (!hasReason(root)) context.report({ node: n.property, messageId: 'reason', data: { modifier: name } })
      },
      // `const { skip } = it`: a skip taken out of a runner, which `skip(…)` later calls without a trace of `it`.
      VariableDeclarator(node) {
        const n = /** @type {any} */ (node)
        if (n.id.type !== 'ObjectPattern' || n.init?.type !== 'Identifier' || !RUNNERS.has(n.init.name)) return
        for (const prop of n.id.properties) {
          const key = prop.type === 'Property' && !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : null
          if (key && MODIFIERS.has(key) && !hasReason(n)) context.report({ node: prop, messageId: 'reason', data: { modifier: key } })
        }
      },
    }
  },
}
