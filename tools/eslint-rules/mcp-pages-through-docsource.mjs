// @ts-check
import { repoPath } from './paths.mjs'

/**
 * `slate/mcp-pages-through-docsource` (A2's request, review A2): the MCP tool layer never holds a
 * `PageDoc`. It asks a `DocSource` for an `AgentPage` and writes through `appendBox`/`createPage`,
 * so `agentBoxes` stays the only reader of a box's content and the CRDT stays on one side of the
 * boundary. Scoped to `packages/mcp/src/{tools,server}.ts`; the two `DocSource` implementations and
 * `core/src/agentView.ts` are the sanctioned holders and stay outside it.
 *
 * What a naive check misses, and this catches: a type-only import (`import type { PageDoc }`), a
 * local alias (`PageDoc as P`), a deep import (`@slate/core/src/page`), a relative path into
 * `packages/core/src`, and a namespace import used later (`core.contentToJSON(…)`). `contentMap` is
 * a `PageDoc` method rather than an export, so any `.contentMap` member access counts too.
 */

/** The names the tool layer may not reach for, whatever they are imported as. */
const BANNED = ['PageDoc', 'contentToJSON', 'contentMap']

/** A `PageDoc` method, so it appears as a member access rather than an import. */
const METHODS = ['contentMap']

/** True for `@slate/core`, a deep path into it, or a relative path landing in packages/core/src. */
function intoCore(/** @type {string} */ file, /** @type {string} */ source) {
  if (source === '@slate/core' || source.startsWith('@slate/core/')) return true
  if (!source.startsWith('.')) return false
  const dir = file.split('/').slice(0, -1)
  for (const part of source.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') dir.pop()
    else dir.push(part)
  }
  return dir.join('/').startsWith('packages/core/src')
}

/** The name an import or export specifier reaches for in the other module. */
function reached(/** @type {any} */ spec) {
  const id = spec.imported ?? spec.local
  return id?.type === 'Identifier' ? id.name : String(id?.value)
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'The MCP tool layer reads and writes pages through a DocSource, never a PageDoc.' },
    messages: {
      page: 'the MCP tool layer never holds a page: read it through `DocSource.readPage` (an `AgentPage`) and write it through `DocSource.appendBox`/`createPage`, so `agentBoxes` stays the only reader of a box\'s content (docs/architecture/golden-paths.md)',
    },
    schema: [],
  },
  create(context) {
    const file = repoPath(context.filename)
    const report = (/** @type {any} */ node) => context.report({ node, messageId: 'page' })
    /** Local names bound to the whole of @slate/core (`import * as core`), checked on use. */
    const namespaces = new Set()
    /** `import('@slate/core')`, `await import(…)` or `require(…)`: the module object without a binding. */
    const loadsCore = (/** @type {any} */ node) => {
      const call = node.type === 'AwaitExpression' ? node.argument : node
      const source = call?.type === 'ImportExpression' ? call.source : call?.type === 'CallExpression' && call.callee.name === 'require' ? call.arguments[0] : null
      return typeof source?.value === 'string' && intoCore(file, source.value)
    }

    /** @param {any} node @param {any} sourceNode */
    const checkImport = (node, sourceNode) => {
      if (typeof sourceNode?.value !== 'string' || !intoCore(file, sourceNode.value)) return
      // `export * from '@slate/core'` re-exports all three by name.
      if (node.type === 'ExportAllDeclaration') return report(node)
      for (const spec of node.specifiers ?? []) {
        // `import * as core` and a default import both bind the whole module; the uses are checked below.
        if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') namespaces.add(spec.local.name)
        else if (BANNED.includes(reached(spec))) report(spec)
      }
    }

    return {
      ImportDeclaration: (node) => checkImport(node, /** @type {any} */ (node).source),
      ExportNamedDeclaration: (node) => checkImport(node, /** @type {any} */ (node).source),
      ExportAllDeclaration: (node) => checkImport(node, /** @type {any} */ (node).source),
      MemberExpression: (/** @type {any} */ node) => {
        if (node.computed || node.property.type !== 'Identifier') return
        if (METHODS.includes(node.property.name)) return report(node)
        if (!BANNED.includes(node.property.name)) return
        // `core.PageDoc`, and the same reach in one step: `(await import('@slate/core')).PageDoc`.
        if (node.object.type === 'Identifier' && namespaces.has(node.object.name)) report(node)
        else if (loadsCore(node.object)) report(node)
      },
      // `core.PageDoc` in a type position (`let p: core.PageDoc`) is a qualified name, not a member expression.
      TSQualifiedName: (/** @type {any} */ node) => {
        if (node.left.type === 'Identifier' && namespaces.has(node.left.name) && BANNED.includes(node.right.name)) report(node)
      },
    }
  },
}
