// @ts-check

/**
 * `slate/no-personal-identifiers`: the main process never reads the machine's or the person's
 * identity from the OS: `os.hostname()`, `os.userInfo()`, `os.networkInterfaces()`. A hostname is
 * often the person's name ("annas-macbook"), `userInfo` is their account and home folder, and the
 * network interfaces carry MAC addresses. Once read they end up in commit authors, device records and
 * logs that leave the machine (GDPR-03). Name a device pseudonymously instead.
 *
 * Every spelling counts, the way `slate/env-through-test-hooks` counts every spelling of
 * `process.env`: a named import (aliased or not), a namespace or default import and its member, a
 * `require` or dynamic `import()` of the module, a destructuring, an alias of the module object, a
 * computed member (`os['hostname']`) and a re-export.
 */

const MODULES = new Set(['os', 'node:os'])
const NAMES = new Set(['hostname', 'userInfo', 'networkInterfaces'])

/** @param {any} node */
const isOsSource = (node) => node?.type === 'Literal' && typeof node.value === 'string' && MODULES.has(node.value)

/** `require('os')`, `import('os')`, `await import('os')`. @param {any} node */
const isOsModuleExpr = (node) => {
  if (!node) return false
  if (node.type === 'AwaitExpression') return isOsModuleExpr(node.argument)
  if (node.type === 'ImportExpression') return isOsSource(node.source)
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && isOsSource(node.arguments[0])
}

/** The member name of `x.name` / `x['name']`, or null. @param {any} node */
const memberName = (node) => {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value
  if (node.computed && node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) return node.property.quasis[0]?.value.cooked ?? null
  return null
}

/** @param {any} pattern */
const destructuresBanned = (pattern) =>
  pattern?.type === 'ObjectPattern' &&
  pattern.properties.some(
    (/** @type {any} */ p) =>
      p.type === 'RestElement' ||
      (p.type === 'Property' && ((!p.computed && p.key.type === 'Identifier' && NAMES.has(p.key.name)) || (p.key.type === 'Literal' && NAMES.has(String(p.key.value))))),
  )

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'No os.hostname(), os.userInfo() or os.networkInterfaces() in the main process.' },
    messages: {
      identifier:
        'Name the device pseudonymously: `Device ${deviceId.slice(0, 8)}` for a device record, and the identity `Slate <slate@invalid>` for a commit; see docs/architecture/golden-paths.md#privacy. ' +
        'os.hostname(), os.userInfo() and os.networkInterfaces() read the person\'s name, account or MAC addresses, which then leave the machine in commits, device records and logs (GDPR-03). ' +
        'A file that truly needs one is a reasoned entry in tools/guards/allowlists/personal-identifiers.json, which only the maintainer grows.',
    },
    schema: [],
  },
  create(context) {
    /** Local names bound to the os module object. */
    const osObjects = new Set()
    /** @param {any} node */
    const report = (node) => context.report({ node, messageId: 'identifier' })

    return {
      ImportDeclaration(node) {
        if (!isOsSource(node.source)) return
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier') {
            const name = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value)
            if (NAMES.has(name)) report(spec)
          } else osObjects.add(spec.local.name)
        }
      },
      ExportNamedDeclaration(node) {
        if (!isOsSource(node.source)) return
        for (const spec of node.specifiers) {
          const name = spec.local.type === 'Identifier' ? spec.local.name : String(spec.local.value)
          if (NAMES.has(name)) report(spec)
        }
      },
      ExportAllDeclaration(node) {
        if (isOsSource(node.source)) report(node)
      },
      VariableDeclarator(node) {
        const init = /** @type {any} */ (node.init)
        const fromOs = isOsModuleExpr(init) || (init?.type === 'Identifier' && osObjects.has(init.name))
        if (!fromOs) return
        if (node.id.type === 'Identifier') osObjects.add(node.id.name)
        else if (destructuresBanned(node.id)) report(node)
      },
      AssignmentExpression(node) {
        const right = /** @type {any} */ (node.right)
        const fromOs = isOsModuleExpr(right) || (right?.type === 'Identifier' && osObjects.has(right.name))
        if (fromOs && node.left.type === 'Identifier') osObjects.add(node.left.name)
        else if (fromOs && destructuresBanned(node.left)) report(node)
      },
      MemberExpression(node) {
        const name = memberName(node)
        if (name === null || !NAMES.has(name)) return
        const obj = /** @type {any} */ (node.object)
        if ((obj.type === 'Identifier' && osObjects.has(obj.name)) || isOsModuleExpr(obj)) report(node)
      },
    }
  },
}
