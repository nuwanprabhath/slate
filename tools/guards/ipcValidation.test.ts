import { ts } from '../lint/ts.mjs'
import { describe, expect, it } from 'vitest'
import { CH } from '../../packages/desktop/src/shared/ipc'
import { allowlist, isTestFile, read, walk } from './repo'

/**
 * C1 (review F7): every `invoke` channel's handler checks its arguments before main acts on them. A
 * handler's parameter types are erased at run time, so `(_e, docId: string)` acts on whatever the
 * untrusted renderer sent; the registrar proves only the sender and the vault state.
 *
 * Read as source with the TypeScript compiler API, so it runs without Electron. Every handled channel
 * (`pre-unlock`, `flush`, `unlocked`) must be registered exactly once, and its handler must be one of:
 * no payload at all; rest parameters whose first statement calls `noArgs`; a `secretHandler(...)` (those
 * channels are pinned by vaultSecrets.test.ts); or a handler whose first statement is
 * `if (<test>) refuse(CH.<the same channel>)`, where the test names every payload parameter and calls
 * only `shared/ipcValidators` exports (or a local type predicate that itself only calls those).
 *
 * The accepted path for a new channel: add a check to packages/desktop/src/shared/ipcValidators.ts and
 * open the handler with `if (!isThing(arg)) refuse(CH.yourChannel)`.
 */

const VALIDATORS = 'packages/desktop/src/shared/ipcValidators.ts'
const POLICY = 'packages/desktop/src/main/ipcGuard.ts'
const EXEMPT = allowlist('ipc-unvalidated')

/** CHANNEL_POLICY read as text: `ipcGuard.ts` imports electron, which a guard test cannot load. */
function channelPolicy(): Map<string, string> {
  const text = read(POLICY)
  const block = /export const CHANNEL_POLICY[^=]*= \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  const rows = new Map([...block.matchAll(/^\s+(\w+): '([a-z-]+)',$/gm)].map((m) => [m[1]!, m[2]!]))
  if (rows.size === 0) throw new Error(`${POLICY}: could not read CHANNEL_POLICY`)
  return rows
}

/** The `keyof typeof CH` names whose policy makes them an `invoke` handler (the registrar's HANDLED set). */
const HANDLED = [...channelPolicy()].filter(([, policy]) => policy === 'pre-unlock' || policy === 'flush' || policy === 'unlocked').map(([key]) => key)

/** SECRET_CHANNELS, read the same way: the channels whose arguments carry a typed secret (Z-5). */
function secretChannels(): string[] {
  const text = read(POLICY)
  const block = /export const SECRET_CHANNELS[^=]*= \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  return [...block.matchAll(/^\s+(\w+): true,$/gm)].map((m) => m[1]!)
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

const SOURCES = walk('packages/desktop/src/main', ['.ts'], isTestFile)
  .filter((f) => !isTestFile(f))
  .map(parse)

/** Every name `shared/ipcValidators.ts` exports: what a handler's test is allowed to call. */
function validatorExports(): Set<string> {
  const out = new Set<string>()
  for (const node of parse(VALIDATORS).statements) {
    const exported = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isFunctionDeclaration(node) && node.name) out.add(node.name.text)
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) out.add(d.name.text)
  }
  if (!out.has('refuse')) throw new Error(`${VALIDATORS}: could not read its exports`)
  return out
}

const EXPORTS = validatorExports()

interface Registration {
  readonly key: string
  readonly file: string
  readonly line: number
  readonly handler: ts.Expression
  readonly source: ts.SourceFile
}

const lineOf = (source: ts.SourceFile, node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

/** Every `<ident>.handle(CH.<key>, <handler>)` in main, by channel key. */
function registrations(): Registration[] {
  const found: Registration[] = []
  for (const source of SOURCES) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'handle' &&
        node.arguments.length === 2 &&
        ts.isPropertyAccessExpression(node.arguments[0]!) &&
        ts.isIdentifier((node.arguments[0] as ts.PropertyAccessExpression).expression) &&
        ((node.arguments[0] as ts.PropertyAccessExpression).expression as ts.Identifier).text === 'CH'
      ) {
        const key = (node.arguments[0] as ts.PropertyAccessExpression).name.text
        found.push({ key, file: source.fileName, line: lineOf(source, node), handler: node.arguments[1]!, source })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

const REGISTERED = registrations()
const where = (r: Registration): string => `${r.file}:${String(r.line)}`

/** The function a registration ends in: through `busy.guard(fn)`, which only wraps it. */
function unwrap(handler: ts.Expression): ts.Expression {
  if (ts.isCallExpression(handler) && ts.isPropertyAccessExpression(handler.expression) && handler.expression.name.text === 'guard' && handler.arguments.length === 1) return unwrap(handler.arguments[0]!)
  return handler
}

const isSecretHandler = (handler: ts.Expression): boolean => ts.isCallExpression(handler) && ts.isIdentifier(handler.expression) && handler.expression.text === 'secretHandler'

const asFunction = (node: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null => (ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : null)

/** The statements of a function body; an arrow with an expression body has none. */
const statements = (fn: ts.ArrowFunction | ts.FunctionExpression): readonly ts.Statement[] => (ts.isBlock(fn.body) ? fn.body.statements : [])

/** The identifiers called by bare name inside `node` (`isDocId(x)`, not `Object.keys(x)`). */
function calledNames(node: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Every identifier named anywhere inside `node`. */
function namedIdentifiers(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/**
 * A file's own type predicates (`const isName = (v: unknown): v is string => …`, or a function
 * declaration), by name, as long as the predicate itself calls only ipcValidators exports. These are
 * C1's locals (`isName`, `isToken`, `isPrompt`, `isSpec`, `isColors`, `isPrintRequest`).
 */
function localPredicates(source: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const keep = (name: string, body: ts.Node): void => {
    if (calledNames(body).every((n) => EXPORTS.has(n) || n === name)) out.add(name)
  }
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.type && ts.isTypePredicateNode(node.type) && node.body) keep(node.name.text, node.body)
    if (!ts.isVariableStatement(node)) continue
    for (const d of node.declarationList.declarations) {
      const init = d.initializer
      if (!ts.isIdentifier(d.name) || !init || !ts.isArrowFunction(init) || !init.type || !ts.isTypePredicateNode(init.type)) continue
      keep(d.name.text, init.body)
    }
  }
  return out
}

/** `refuse` must be the one from shared/ipcValidators, not a local of the same name. */
function importsRefuse(source: ts.SourceFile): boolean {
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !/ipcValidators$/.test(node.moduleSpecifier.text)) continue
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => e.name.text === 'refuse')) return true
  }
  return false
}

/** The channel key a `refuse(CH.<key>)` names, or null when the statement is not that refusal. */
function refusedChannel(statement: ts.Statement): string | null {
  if (!ts.isIfStatement(statement)) return null
  const then = statement.thenStatement
  const only = ts.isBlock(then) ? (then.statements.length === 1 ? then.statements[0] : undefined) : then
  if (!only || !ts.isExpressionStatement(only)) return null
  const call = only.expression
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'refuse' || call.arguments.length !== 1) return null
  const arg = call.arguments[0]!
  if (!ts.isPropertyAccessExpression(arg) || !ts.isIdentifier(arg.expression) || arg.expression.text !== 'CH') return null
  return arg.name.text
}

/** Why this registration does not check its arguments, or null when it does. */
function unchecked(r: Registration): string | null {
  const handler = unwrap(r.handler)
  if (isSecretHandler(handler)) return null
  const fn = asFunction(handler)
  if (!fn) return `${where(r)}: the handler for ${CH[r.key as keyof typeof CH]} is not a function literal, a secretHandler(…) or a busy.guard(…) this guard can read`
  const payload = fn.parameters.slice(1)
  if (payload.length === 0) return null

  const body = statements(fn)
  const first = body[0]
  if (!first) return `${where(r)}: the handler for ${CH[r.key as keyof typeof CH]} takes arguments but has no body to check them in`

  if (payload.length === 1 && payload[0]!.dotDotDotToken) {
    const calls = ts.isExpressionStatement(first) ? calledNames(first.expression) : []
    return calls.includes('noArgs') ? null : `${where(r)}: ${CH[r.key as keyof typeof CH]} takes rest parameters, so its first statement must call noArgs(…) (see main/pqIpc.ts)`
  }

  const refused = refusedChannel(first)
  if (refused === null) return `${where(r)}: the first statement of ${CH[r.key as keyof typeof CH]}'s handler must be \`if (<test>) refuse(CH.${r.key})\``
  if (refused !== r.key) return `${where(r)}: ${CH[r.key as keyof typeof CH]}'s handler refuses as CH.${refused}; a refusal names the channel it was registered on`
  if (!importsRefuse(r.source)) return `${where(r)}: ${r.file} must import refuse from shared/ipcValidators`

  // Not `test`: a local of that name reads as vitest's, which slate/tests-registered-unconditionally refuses.
  const condition = (first as ts.IfStatement).expression
  const named = namedIdentifiers(condition)
  for (const p of payload) {
    const name = ts.isIdentifier(p.name) ? p.name.text : null
    if (name && !named.has(name)) return `${where(r)}: ${CH[r.key as keyof typeof CH]}'s handler acts on \`${name}\` without checking it`
  }
  const locals = localPredicates(r.source)
  for (const called of calledNames(condition)) {
    if (!EXPORTS.has(called) && !locals.has(called)) return `${where(r)}: ${CH[r.key as keyof typeof CH]}'s test calls \`${called}\`, which is neither exported from shared/ipcValidators nor a local type predicate built only from those`
  }
  return null
}

describe('ipc validation: every invoke handler checks its arguments', () => {
  it('reads the handlers it is meant to read', () => {
    expect(HANDLED.length).toBeGreaterThan(50)
    expect(REGISTERED.length).toBeGreaterThan(50)
  })

  it('every handled channel is registered exactly once', () => {
    const counts = new Map<string, Registration[]>()
    for (const r of REGISTERED) counts.set(r.key, [...(counts.get(r.key) ?? []), r])
    const wrong: string[] = []
    for (const key of HANDLED) {
      const found = counts.get(key) ?? []
      if (found.length === 0) wrong.push(`${CH[key as keyof typeof CH]} (CH.${key}) has no handler in packages/desktop/src/main`)
      if (found.length > 1) wrong.push(`${CH[key as keyof typeof CH]} is registered ${String(found.length)} times: ${found.map(where).join(', ')}`)
    }
    expect(wrong).toEqual([])
  })

  it('every handler with arguments checks them before main acts', () => {
    const problems: string[] = []
    for (const r of REGISTERED) {
      if (!HANDLED.includes(r.key)) continue
      if (r.key in EXEMPT) continue
      const why = unchecked(r)
      if (why) problems.push(why)
    }
    expect(problems).toEqual([])
  })

  it('every exemption is a channel that still exists, and the list only shrinks (ratchet.test.ts)', () => {
    expect(Object.keys(EXEMPT).filter((key) => !HANDLED.includes(key))).toEqual([])
  })

  // A plain handler on a secret channel would leave main's copy of the secret unzeroed (Z-5), and a
  // secretHandler on an ordinary one would hide it from this guard's rule.
  it('secretHandler is used on exactly the SECRET_CHANNELS', () => {
    const used = REGISTERED.filter((r) => isSecretHandler(unwrap(r.handler))).map((r) => r.key)
    expect([...used].sort()).toEqual([...secretChannels()].sort())
  })
})
