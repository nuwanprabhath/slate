// @ts-check

/**
 * `slate/env-through-test-hooks`: main never touches `process.env` outside src/main/testHooks.ts.
 * It reads one documented variable with `env(name)` (typed to TEST_HOOK_VARS, which a packaged app
 * scrubs, APP_ENV_VARS and PLATFORM_ENV_VARS), or hands a pure function `envSnapshot()`, a copy
 * holding only those names. Any reference counts: `process.env.X`, `process['env']`, an alias, a
 * destructuring, a default parameter, `Object.entries(process.env)`. Each was a way a new variable
 * went unseen.
 */

/** @param {any} node */
const isProcessEnv = (node) =>
  node.type === 'MemberExpression' &&
  node.object.type === 'Identifier' &&
  node.object.name === 'process' &&
  ((!node.computed && node.property.type === 'Identifier' && node.property.name === 'env') ||
    (node.computed && node.property.type === 'Literal' && node.property.value === 'env'))

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'process.env only in src/main/testHooks.ts.' },
    messages: {
      direct:
        "Read a variable with `env('NAME')` from src/main/testHooks.ts, or pass `envSnapshot()` to a function that needs several; never `process.env`. A new name goes in testHooks.ts first: " +
        'TEST_HOOK_VARS if it weakens or redirects the app (scrubTestHooks deletes those in a packaged build), else APP_ENV_VARS or PLATFORM_ENV_VARS with its reason in ' +
        'tools/guards/allowlists/env-vars.json. See docs/architecture/golden-paths.md#a-test-hook.',
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isProcessEnv(node)) context.report({ node, messageId: 'direct' })
      },
      // `const { env } = process` (red team G2-7).
      VariableDeclarator(node) {
        const init = /** @type {any} */ (node.init)
        if (node.id.type !== 'ObjectPattern' || init?.type !== 'Identifier' || init.name !== 'process') return
        if (node.id.properties.some((p) => p.type === 'RestElement' || (p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'env'))) context.report({ node, messageId: 'direct' })
      },
      // The global `process` is the one there is; importing the module is how an alias hides (G2-7).
      ImportDeclaration(node) {
        if (node.source.value === 'process' || node.source.value === 'node:process') context.report({ node, messageId: 'direct' })
      },
    }
  },
}
