// @ts-check
import { repoPath } from './paths.mjs'

/**
 * `slate/tests-registered-unconditionally`: `it`, `test` and `describe` (and their `.only`, `.skip`,
 * `.each`, `.describe`… forms) are registered at module or `describe` level without an `if`, ternary,
 * `&&`/`||`, `switch` or `try` around them. A test registered under a condition silently does not
 * exist when the condition is false: CI stays green and the skip ratchet does not see it (review M-R1
 * of phase11/c8). Loops are allowed: parametrised tests are legitimate.
 *
 * C11 closes the indirect forms the C8 review left (each a test that may not exist):
 * - a loop, `forEach` or `map` over a list that is itself conditional (`for (const c of linux ? CASES : [])`,
 *   or through a `const` that holds such a list);
 * - a runner chosen by a condition (`const maybe = linux ? it : it.skip`, `(cond && describe)(…)`);
 * - a helper that registers a test under a condition (`function maybe(n, f) { if (linux) it(n, f) }`).
 * Review C11 adds: an early `return`/`throw`/`break`/`continue` under a condition before the registration, a
 * conditional list given to `.each` or reached through `let`, a spread, `.slice()` and the like, an indexed `for`
 * whose bound is conditional, and `while`/`do` loops (which cannot be judged statically: loop over a list). A
 * runner is only ever called by its name: an alias (`const t = it`, `const { skip } = it`, `[it, f][i]`) or a
 * computed access (`it['skip']`, `R[cond ? 'a' : 'b'](title, fn)`) is refused, and so is importing a runner under
 * another name or through a namespace (`import { it as t }`, `import * as v from 'vitest'`).
 * A loop over a list built by any other means (a filter, a computation) is still allowed; review sees it.
 */
/** The runner names of the file being linted (set at Program; ESLint lints one file at a time). */
let RUNNERS = new Set(['it', 'test', 'describe'])

/** Where runners come from: a namespace import of one of these is refused, and its name resolved as a runner. */
const RUNNER_SOURCES = /^(vitest|@playwright\/test)$|(^|\/)fixtures(\.[cm]?[jt]s)?$/

/** The one file that may make a runner with `.extend(…)`; every other file imports `test` from it. */
export const FIXTURES_FILE = 'packages/desktop/e2e/fixtures.ts'

/** `import('vitest')`, `await import('…/fixtures')`, `require('@playwright/test')`: a runner module loaded at run time. */
export function dynamicRunnerSource(/** @type {any} */ node) {
  let n = node
  if (n?.type === 'AwaitExpression') n = n.argument
  if (n?.type === 'ImportExpression') return n.source.type === 'Literal' && RUNNER_SOURCES.test(String(n.source.value))
  if (n?.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') return n.arguments[0]?.type === 'Literal' && RUNNER_SOURCES.test(String(n.arguments[0].value))
  return false
}

/** The identifier a member or call chain starts from (`test` for `test.extend({…}).extend({…})`). */
function chainRoot(/** @type {any} */ node) {
  let n = node
  while (n) {
    if (n.type === 'Identifier') return n.name
    if (n.type === 'MemberExpression') n = n.object
    else if (n.type === 'CallExpression') n = n.callee
    else if (n.type === 'AwaitExpression' || n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') n = n.type === 'AwaitExpression' ? n.argument : n.expression
    else return null
  }
  return null
}

/**
 * The names this file calls runners by: `it`, `test`, `describe`, any local name an import gives one
 * (`import { it as t }`, `import * as v from 'vitest'`), and, transitively, any variable initialised from a runner
 * (`const x = test.extend({…})`, `const t = it`) or destructured from a runner module loaded at run time
 * (`const { it: t } = await import('vitest')`). slate/tests-registered-unconditionally refuses all of these but the
 * fixtures file's own `test`; both rules still resolve them, so what they hide is seen while the refusal stands.
 */
export function runnerNames(/** @type {any} */ program) {
  const names = new Set(['it', 'test', 'describe'])
  /** @type {any[]} */
  const declarators = []
  const walk = (/** @type {any} */ n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'ImportDeclaration') {
      for (const sp of n.specifiers) {
        if (sp.type === 'ImportSpecifier' && sp.imported.type === 'Identifier' && ['it', 'test', 'describe'].includes(sp.imported.name)) names.add(sp.local.name)
        if (sp.type === 'ImportNamespaceSpecifier' && RUNNER_SOURCES.test(String(n.source.value))) names.add(sp.local.name)
      }
    }
    if (n.type === 'VariableDeclarator') declarators.push(n)
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(program)
  for (let grew = true; grew; ) {
    grew = false
    for (const d of declarators) {
      const add = (/** @type {string} */ name) => {
        if (!names.has(name)) {
          names.add(name)
          grew = true
        }
      }
      if (dynamicRunnerSource(d.init) && d.id.type === 'ObjectPattern') {
        for (const prop of d.id.properties) if (prop.type === 'Property' && prop.value.type === 'Identifier') add(prop.value.name)
      } else if (dynamicRunnerSource(d.init) && d.id.type === 'Identifier') add(d.id.name)
      const root = d.init ? chainRoot(d.init) : null
      if (root && names.has(root)) {
        if (d.id.type === 'Identifier') add(d.id.name)
        else if (d.id.type === 'ObjectPattern') for (const prop of d.id.properties) if (prop.type === 'Property' && prop.value.type === 'Identifier') add(prop.value.name)
      }
    }
  }
  return names
}

const CONDITIONAL = new Set(['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchCase', 'TryStatement'])
const FUNCTION = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'])
const LOOP = new Set(['ForOfStatement', 'ForInStatement'])
const ITERATE = new Set(['forEach', 'map', 'flatMap'])
const HOOKS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach'])
/** Playwright calls on `test` that take a title and a function but register no test. */
const NOT_REGISTRATION = new Set(['step', 'extend', 'use', 'info', 'setTimeout', 'slow', 'fixme', 'fail', 'skip', 'configure'])

/** The identifier a call chain starts from: `it` for `it.each([…])('x', f)` and `test.describe.only(…)`. */
function rootName(/** @type {any} */ callee) {
  let n = callee
  while (n) {
    if (n.type === 'Identifier') return n.name
    if (n.type === 'MemberExpression') n = n.object
    else if (n.type === 'CallExpression') n = n.callee
    else return null
  }
  return null
}

const isRunnerCall = (/** @type {any} */ node) => node?.type === 'CallExpression' && RUNNERS.has(rootName(node.callee) ?? '')

/** `describe(…)`, `describe.only(…)`, `test.describe(…)`, `test.describe.serial(…)`. */
const isDescribe = (/** @type {any} */ node) => {
  if (!isRunnerCall(node)) return false
  for (let c = node.callee; c; c = c.type === 'MemberExpression' ? c.object : c.type === 'CallExpression' ? c.callee : null) {
    if ((c.type === 'Identifier' && c.name === 'describe') || (c.type === 'MemberExpression' && c.property?.name === 'describe')) return true
  }
  return false
}

/** A test body or a hook: a function handed to a runner or hook call. A condition there is test logic. */
const isBodyOrHook = (/** @type {any} */ fn) => {
  const call = fn.parent
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return false
  const root = rootName(call.callee)
  if (HOOKS.has(root ?? '')) return true
  if (call.callee.type === 'MemberExpression' && HOOKS.has(call.callee.property?.name)) return true
  return RUNNERS.has(root ?? '')
}

/** Registers a test or suite: a runner call with a title (and its body), not a Playwright step, annotation or fixture. */
const isRegistration = (/** @type {any} */ call) => {
  if (call.arguments.length === 0) return false
  for (let c = call.callee; c?.type === 'MemberExpression' || c?.type === 'CallExpression'; c = c.type === 'MemberExpression' ? c.object : c.callee) {
    if (c.type === 'MemberExpression' && NOT_REGISTRATION.has(c.property?.name)) return false
  }
  return true
}

const unwrap = (/** @type {any} */ e) => {
  while (e?.type === 'TSAsExpression' || e?.type === 'TSNonNullExpression' || e?.type === 'TSSatisfiesExpression') e = e.expression
  return e
}
/** Array methods whose result is a copy (or a part) of the list they are called on. */
const LIST_METHODS = new Set(['slice', 'concat', 'filter', 'map', 'flat', 'flatMap', 'toSorted', 'toReversed', 'toSpliced', 'reverse', 'sort', 'with'])

/**
 * A list that may be empty or different under a condition: `cond ? a : b`, `a && b`, a spread or a copy of one
 * (`[...x]`, `x.slice()`), or a variable whose value is one. A `let` or `var` that is reassigned anywhere cannot
 * be judged, so it counts as conditional.
 */
function conditionalList(/** @type {any} */ expr, /** @type {any} */ scope, depth = 0, reassignedCounts = true) {
  const e = unwrap(expr)
  if (!e || depth > 8) return false
  if (e.type === 'ConditionalExpression' || e.type === 'LogicalExpression') return true
  if (e.type === 'ArrayExpression') return e.elements.some((/** @type {any} */ el) => el?.type === 'SpreadElement' && conditionalList(el.argument, scope, depth + 1))
  if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && LIST_METHODS.has(e.callee.property?.name)) {
    return conditionalList(e.callee.object, scope, depth + 1) || e.arguments.some((/** @type {any} */ a) => conditionalList(a.type === 'SpreadElement' ? a.argument : a, scope, depth + 1))
  }
  if (e.type !== 'Identifier' || !scope) return false
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(e.name)
    if (!v) continue
    const def = v.defs[0]
    if (def?.type !== 'Variable') return false
    if (def.parent?.kind !== 'const' && v.references.some((/** @type {any} */ r) => r.isWrite() && !r.init)) return reassignedCounts
    return conditionalList(def.node.init, scope, depth + 1)
  }
  return false
}

/** Whether `node` holds a conditional expression or names a conditional list (an indexed loop's bound). */
function conditionalBound(/** @type {any} */ node, /** @type {any} */ scope) {
  let found = false
  const walk = (/** @type {any} */ n) => {
    if (found || !n || typeof n.type !== 'string') return
    if (n.type === 'ConditionalExpression' || n.type === 'LogicalExpression') found = true
    // A loop counter is reassigned by the loop itself; only a bound whose value is a conditional list counts.
    else if (n.type === 'Identifier' && conditionalList(n, scope, 0, false)) found = true
    else if (n.type === 'MemberExpression') walk(n.object)
    else for (const k of ['left', 'right', 'argument', 'expression', 'callee']) walk(n[k])
  }
  walk(node)
  return found
}

const EXIT = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'])
const BRANCH = new Set(['IfStatement', 'SwitchStatement', 'TryStatement'])

/** A statement that may leave early: an exit inside an if, switch or try (not inside a nested function). */
function conditionalExit(/** @type {any} */ stmt) {
  if (!BRANCH.has(stmt?.type)) return false
  let found = false
  const walk = (/** @type {any} */ n) => {
    if (found || !n || typeof n.type !== 'string' || FUNCTION.has(n.type)) return
    if (EXIT.has(n.type)) {
      found = true
      return
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(stmt)
  return found
}

/** Names that are not a use of the runner: its declaration, an import, a property name, a type. */
function declaresOrNames(/** @type {any} */ n) {
  const p = n.parent
  if (!p) return true
  if (p.type === 'ImportSpecifier' || p.type === 'ImportDefaultSpecifier' || p.type === 'ImportNamespaceSpecifier' || p.type === 'ExportSpecifier') return true
  if (p.type === 'VariableDeclarator' && p.id === n) return true
  if (p.type === 'MemberExpression' && p.property === n && !p.computed) return true
  if (p.type === 'Property' && p.key === n && !p.shorthand) return true
  if (p.type === 'Property' && p.parent?.type === 'ObjectPattern') return true
  if (FUNCTION.has(p.type) && p.params.includes(n)) return true
  // Types, type members and declarations (`{ test: string }`, `typeof it`) name, they do not call.
  if (p.type.startsWith('TS') && p.type !== 'TSAsExpression' && p.type !== 'TSNonNullExpression' && p.type !== 'TSSatisfiesExpression') return true
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Tests are registered unconditionally at module and describe level.' },
    messages: {
      unconditional:
        'Register this test unconditionally. If it cannot run yet, write `it.todo(\'<what> (<work package>)\')` (vitest) and keep the body in a helper; for a platform, use `it.skipIf(cond)` / Playwright `test.skip(cond, \'why\')`, which the skip ratchet counts (tools/guards/testConfig.test.ts). ' +
        'A test inside an if, ternary, &&, switch or try simply does not exist when the condition is false, and nothing notices.',
      conditionalLoop:
        'This loop registers tests over a list that is empty or different under a condition, so its tests may not exist. Loop over the full list and use `it.skipIf(cond)` per case, which the skip ratchet counts.',
      chosenRunner:
        'A runner chosen by a condition (`cond ? it : it.skip`) registers a test that may not exist or not run, unseen. Use `it.skipIf(cond)` / `it.runIf(cond)` with a reason.',
      helper:
        'This helper registers a test only under a condition, so the test may not exist. Register it unconditionally with `it.skipIf(cond)`, which the skip ratchet counts.',
      whileLoop:
        'A while or do loop registering tests cannot be judged statically: how many tests exist depends on a condition. Loop with for-of over a full list, and `it.skipIf(cond)` per case.',
      aliasRunner:
        'Call `it`, `test` and `describe` by their own names: an alias or a list holding one (`const t = it`, `const { skip } = it`, `[it, f][i]`) hides which tests exist and which are skipped.',
      extendOutsideFixtures:
        'Only packages/desktop/e2e/fixtures.ts makes a runner with `.extend(…)`. Import `test` (and `expect`) from \'./fixtures\' and add the fixture there: a runner under another name hides which tests exist and which are skipped.',
      dynamicRunnerImport:
        'Import runners statically by their own names (`import { describe, expect, it } from \'vitest\'`, `import { expect, test } from \'./fixtures\'`). A runner loaded with `import()` or `require()` is invisible to the guards and the skip ratchet.',
      renamedRunner:
        'Import runners under their own names: `import { describe, expect, it } from \'vitest\'` or `import { expect, test } from \'./fixtures\'`. A renamed or namespace import (`it as t`, `import * as v`) hides which tests exist and which are skipped from the guards and the skip ratchet.',
      computedRunner:
        'A runner reached by a computed name (`it[\'skip\']`, `R[cond ? a : b](title, fn)`) hides which tests exist and which are skipped. Call it by name; for a platform, `it.skipIf(cond)` with a reason.',
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    return {
      Program(node) {
        RUNNERS = runnerNames(node)
      },
      ImportDeclaration(node) {
        const d = /** @type {any} */ (node)
        for (const sp of d.specifiers) {
          const renamed = sp.type === 'ImportSpecifier' && sp.imported.type === 'Identifier' && ['it', 'test', 'describe'].includes(sp.imported.name) && sp.local.name !== sp.imported.name
          const namespace = sp.type === 'ImportNamespaceSpecifier' && RUNNER_SOURCES.test(String(d.source.value))
          // The fixtures file's `import { test as base } …; export const test = base.extend({…})` registers nothing.
          const onlyExtended =
            renamed &&
            repoPath(context.filename) === FIXTURES_FILE &&
            source.getDeclaredVariables(sp)[0]?.references.every((/** @type {any} */ r) => r.identifier.parent?.type === 'MemberExpression' && r.identifier.parent.object === r.identifier && r.identifier.parent.property?.name === 'extend')
          if ((renamed && !onlyExtended) || namespace) context.report({ node: sp, messageId: 'renamedRunner' })
        }
      },
      ImportExpression(node) {
        if (dynamicRunnerSource(node)) context.report({ node, messageId: 'dynamicRunnerImport' })
      },
      Identifier(node) {
        const n = /** @type {any} */ (node)
        if (!RUNNERS.has(n.name) || declaresOrNames(n)) return
        // The top of the expression this identifier starts (`it`, `it.skip`, `test.describe`), not called.
        let top = n
        while (top.parent?.type === 'MemberExpression' && top.parent.object === top) {
          if (top.parent.computed) {
            context.report({ node: top.parent, messageId: 'computedRunner' })
            return
          }
          top = top.parent
        }
        const p = top.parent
        if ((p?.type === 'ConditionalExpression' && p.test !== top) || p?.type === 'LogicalExpression') {
          context.report({ node: top, messageId: 'chosenRunner' })
          return
        }
        if (p?.type === 'CallExpression' && p.callee === top) return
        // `typeof it`, `void test`: no use as a runner.
        if (p?.type === 'UnaryExpression' || p?.type === 'ExpressionStatement' || (p?.type === 'ConditionalExpression' && p.test === top)) return
        context.report({ node: top, messageId: 'aliasRunner' })
      },
      CallExpression(node) {
        const n = /** @type {any} */ (node)
        // `R[cond ? 'a' : 'b'](title, fn)`: a call by computed name with a test's shape.
        if (n.callee.type === 'MemberExpression' && n.callee.computed && n.callee.property.type !== 'Literal' && n.callee.object.type !== 'ArrayExpression') {
          const first = n.arguments[0]
          const titled = (first?.type === 'Literal' && typeof first.value === 'string') || first?.type === 'TemplateLiteral'
          if (titled && n.arguments.some((/** @type {any} */ a) => FUNCTION.has(a.type))) context.report({ node: n, messageId: 'computedRunner' })
        }
        if (dynamicRunnerSource(n)) context.report({ node: n, messageId: 'dynamicRunnerImport' })
        // `<runner>.extend(…)` makes a runner: only in the fixtures file, under the name `test`.
        if (n.callee.type === 'MemberExpression' && n.callee.property?.name === 'extend' && RUNNERS.has(chainRoot(n.callee.object) ?? '')) {
          const decl = n.parent?.type === 'VariableDeclarator' && n.parent.init === n ? n.parent : null
          if (repoPath(context.filename) !== FIXTURES_FILE || decl?.id.type !== 'Identifier' || decl.id.name !== 'test') context.report({ node: n, messageId: 'extendOutsideFixtures' })
        }
        if (!isRunnerCall(n)) return
        // Report the outermost call of a chain once (`it.each([…])` inside `it.each([…])(…)`).
        if (n.parent?.type === 'CallExpression' && n.parent.callee === n) return
        // `.each(list)` / `.for(list)` is a loop over that list.
        for (let c = n.callee; c?.type === 'CallExpression' || c?.type === 'MemberExpression'; c = c.type === 'CallExpression' ? c.callee : c.object) {
          if (c.type === 'CallExpression' && c.callee.type === 'MemberExpression' && (c.callee.property?.name === 'each' || c.callee.property?.name === 'for') && conditionalList(c.arguments[0], source.getScope(c))) {
            context.report({ node, messageId: 'conditionalLoop' })
            return
          }
        }
        let guarded = false
        /** @type {any} */
        let child = n
        for (let p = n.parent; p; child = p, p = p.parent) {
          if (LOOP.has(p.type) && p.body === child && conditionalList(p.right, source.getScope(p))) {
            context.report({ node, messageId: 'conditionalLoop' })
            return
          }
          if (p.type === 'ForStatement' && p.body === child && conditionalBound(p.test, source.getScope(p))) {
            context.report({ node, messageId: 'conditionalLoop' })
            return
          }
          if ((p.type === 'WhileStatement' || p.type === 'DoWhileStatement') && p.body === child) {
            context.report({ node, messageId: 'whileLoop' })
            return
          }
          // An early exit under a condition before this statement: what follows may not run.
          if ((p.type === 'BlockStatement' || p.type === 'Program') && p.body.slice(0, p.body.indexOf(child)).some(conditionalExit)) guarded = true
          if (FUNCTION.has(p.type)) {
            // `list.forEach((c) => it(…))` is a loop: the search goes on past it, and the list is checked.
            const iter = p.parent
            if (iter?.type === 'CallExpression' && iter.arguments[0] === p && iter.callee.type === 'MemberExpression' && ITERATE.has(iter.callee.property?.name)) {
              if (conditionalList(iter.callee.object, source.getScope(iter))) {
                context.report({ node, messageId: 'conditionalLoop' })
                return
              }
              continue
            }
            // In a test body or hook a condition is ordinary logic. In a describe callback the search stops
            // there: the describe call is checked on its own.
            if (isDescribe(p.parent)) break
            if (isBodyOrHook(p)) return
            // Any other function is a helper: a test it registers under a condition may not exist.
            if (guarded && isRegistration(n)) context.report({ node, messageId: 'helper' })
            return
          }
          if (CONDITIONAL.has(p.type) && !(p.type === 'ConditionalExpression' && p.test === child) && !(p.type === 'IfStatement' && p.test === child)) guarded = true
        }
        if (guarded) context.report({ node, messageId: 'unconditional' })
      },
    }
  },
}
