import { ts } from '../lint/ts.mjs'
import { read } from './repo'

/**
 * The egress scanner behind egress.test.ts: finds every place shipped code can reach the network,
 * and every privacy gate a file calls. It reads the AST, not text, so a method that happens to be
 * called `fetch` (`private async fetch()`) is not a sink, while `fetch` passed on as a value
 * (`deps.fetch ?? fetch`, the GitHub device flow's default) is.
 *
 * A sink is one of:
 * - `fetch`: the global fetch, called or passed on as a value (`= fetch`, `?? fetch`, `{ fetch }`),
 *   or as `globalThis.fetch`;
 * - `net.fetch` / `net.request` (Electron's net, by any imported name);
 * - `http(s).request` / `.get`, `http2.connect`, `tls.connect`, `net.connect` / `createConnection`
 *   (Node, as a namespace, a default import, a named import or a require);
 * - `autoUpdater.checkForUpdates` / `checkForUpdatesAndNotify` / `downloadUpdate` (on any object);
 * - `new PublicClientApplication` / `ConfidentialClientApplication` (MSAL);
 * - the git transport: `nodeGitRunner` called or passed on;
 * - spawning `claude`: the literal program name `claude` (or `command -v claude`) in a file that
 *   starts processes;
 * - `shell.openExternal` (the system browser);
 * - `setSpellCheckerDictionaryDownloadURL` (Chromium's Hunspell download);
 * - `new WebSocket` / `EventSource` / `XMLHttpRequest`.
 */

export interface Sink {
  kind: string
  line: number
}

const NODE_NET: Record<string, readonly string[]> = {
  http: ['request', 'get'],
  https: ['request', 'get'],
  http2: ['connect'],
  net: ['connect', 'createConnection'],
  tls: ['connect'],
}
const ELECTRON = /^electron(\/(main|common))?$/
const MSAL = new Set(['PublicClientApplication', 'ConfidentialClientApplication'])
const UPDATER = new Set(['checkForUpdates', 'checkForUpdatesAndNotify', 'downloadUpdate'])
const GLOBALS = new Set(['globalThis', 'global', 'window', 'self'])
const SOCKETS = new Set(['WebSocket', 'EventSource', 'XMLHttpRequest'])
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork', 'spawnProgram', 'runFile'])
const CLAUDE = /^claude$|\bcommand -v claude\b/

const nodeModule = (spec: string): string | null => {
  const bare = spec.replace(/^node:/, '')
  return bare in NODE_NET ? bare : null
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** An identifier used as a value: not a declaration's name, a member name, an import name or a type. */
function isValueRef(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p)) return false
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isImportEqualsDeclaration(p)) return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if (ts.isShorthandPropertyAssignment(p)) return true
  const named =
    ts.isPropertyAssignment(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isEnumMember(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isBindingElement(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p)
  return !(named && (p as { name?: ts.Node }).name === id)
}

/** `require('x')`, `import('x')`, `await import('x')`: the module name, or null. */
function moduleOf(expr: ts.Expression | undefined): string | null {
  if (!expr) return null
  if (ts.isAwaitExpression(expr)) return moduleOf(expr.expression)
  if (ts.isParenthesizedExpression(expr)) return moduleOf(expr.expression)
  if (!ts.isCallExpression(expr)) return null
  const arg = expr.arguments[0]
  const isRequire = ts.isIdentifier(expr.expression) && expr.expression.text === 'require'
  const isImport = expr.expression.kind === ts.SyntaxKind.ImportKeyword
  return (isRequire || isImport) && arg && ts.isStringLiteralLike(arg) ? arg.text : null
}

interface Bindings {
  /** Local name → Node network module, for a namespace or default binding (`import https from 'node:https'`). */
  nodeNs: Map<string, string>
  /** Local name → sink kind, for a named binding of a sink function (`import { connect } from 'node:tls'`). */
  fns: Map<string, string>
  /** Local names of Electron's `net`. */
  electronNet: Set<string>
  /** Local names of Electron's `shell`. */
  electronShell: Set<string>
  /** Local names of an Electron namespace (`import * as electron from 'electron'`). */
  electronNs: Set<string>
  /** Local names of an MSAL client class, or of the MSAL namespace. */
  msal: Set<string>
  msalNs: Set<string>
}

/** Records what one module binding brings in: `named` maps each imported name to its local name. */
function bind(b: Bindings, spec: string, ns: string | null, named: ReadonlyArray<readonly [string, string]>): void {
  const mod = nodeModule(spec)
  if (mod) {
    if (ns) b.nodeNs.set(ns, mod)
    for (const [imported, local] of named) if (NODE_NET[mod]!.includes(imported)) b.fns.set(local, `${mod}.${imported}`)
  } else if (ELECTRON.test(spec)) {
    if (ns) b.electronNs.add(ns)
    for (const [imported, local] of named) {
      if (imported === 'net') b.electronNet.add(local)
      if (imported === 'shell') b.electronShell.add(local)
    }
  } else if (spec === '@azure/msal-node') {
    if (ns) b.msalNs.add(ns)
    for (const [imported, local] of named) if (MSAL.has(imported)) b.msal.add(local)
  } else if (spec === '@slate/sync' || /(^|\/)gitRunner(\.ts)?$/.test(spec)) {
    for (const [imported, local] of named) if (imported === 'nodeGitRunner') b.fns.set(local, 'git transport (nodeGitRunner)')
  }
}

function collectBindings(sf: ts.SourceFile): Bindings {
  const b: Bindings = { nodeNs: new Map(), fns: new Map(), electronNet: new Set(), electronShell: new Set(), electronNs: new Set(), msal: new Set(), msalNs: new Set() }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const nb = clause?.namedBindings
      const ns = clause?.name?.text ?? (nb && ts.isNamespaceImport(nb) ? nb.name.text : null)
      const named = nb && ts.isNamedImports(nb) ? nb.elements.map((e) => [(e.propertyName ?? e.name).text, e.name.text] as const) : []
      bind(b, node.moduleSpecifier.text, ns, named)
    } else if (ts.isVariableDeclaration(node)) {
      const spec = moduleOf(node.initializer)
      if (spec !== null) {
        if (ts.isIdentifier(node.name)) bind(b, spec, node.name.text, [])
        else if (ts.isObjectBindingPattern(node.name)) {
          const named = node.name.elements.flatMap((e) => {
            const key = e.propertyName ?? e.name
            return ts.isIdentifier(key) && ts.isIdentifier(e.name) ? [[key.text, e.name.text] as const] : []
          })
          bind(b, spec, null, named)
        }
      } else if (node.initializer && ts.isIdentifier(node.initializer) && ts.isIdentifier(node.name)) {
        // One step of aliasing: `const n = net`.
        const from = node.initializer.text
        const to = node.name.text
        const mod = b.nodeNs.get(from)
        if (mod) b.nodeNs.set(to, mod)
        if (b.electronNet.has(from)) b.electronNet.add(to)
        if (b.electronShell.has(from)) b.electronShell.add(to)
        if (b.msal.has(from)) b.msal.add(to)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return b
}

/** Every network sink in one source file. */
export function findSinks(file: string, text: string): Sink[] {
  const sf = parse(file, text)
  const b = collectBindings(sf)
  const sinks: Sink[] = []
  const add = (node: ts.Node, kind: string): void => {
    sinks.push({ kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
  }
  let launches = false
  const claudeLiterals: ts.Node[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueRef(node)) {
      if (node.text === 'fetch') add(node, 'fetch')
      const fn = b.fns.get(node.text)
      if (fn) add(node, fn)
      if (LAUNCHERS.has(node.text)) launches = true
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      const obj = node.expression
      const objName = ts.isIdentifier(obj) ? obj.text : null
      const isElectronNet = (objName !== null && b.electronNet.has(objName)) || (ts.isPropertyAccessExpression(obj) && obj.name.text === 'net' && ts.isIdentifier(obj.expression) && b.electronNs.has(obj.expression.text))
      const mod = objName === null ? undefined : b.nodeNs.get(objName)
      if (name === 'fetch' && objName !== null && GLOBALS.has(objName)) add(node, 'fetch')
      else if (isElectronNet && (name === 'fetch' || name === 'request')) add(node, `net.${name}`)
      else if (mod && NODE_NET[mod]!.includes(name)) add(node, `${mod}.${name}`)
      else if (UPDATER.has(name)) add(node, `autoUpdater.${name}`)
      else if (name === 'setSpellCheckerDictionaryDownloadURL' && ts.isCallExpression(node.parent)) add(node, 'spellcheck dictionary download')
      else if (name === 'openExternal' && ((objName !== null && b.electronShell.has(objName)) || (ts.isPropertyAccessExpression(obj) && obj.name.text === 'shell'))) add(node, 'shell.openExternal')
      if (LAUNCHERS.has(name)) launches = true
    } else if (ts.isNewExpression(node)) {
      const e = node.expression
      if (ts.isIdentifier(e) && b.msal.has(e.text)) add(node, `new ${e.text}`)
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && b.msalNs.has(e.expression.text) && MSAL.has(e.name.text)) add(node, `new ${e.name.text}`)
      else if (ts.isIdentifier(e) && SOCKETS.has(e.text)) add(node, `new ${e.text}`)
    } else if (ts.isStringLiteralLike(node) && CLAUDE.test(node.text)) {
      claudeLiterals.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (launches) for (const lit of claudeLiterals) add(lit, 'spawns claude')
  return sinks.sort((x, y) => x.line - y.line)
}

/** The privacy gates and the module each must come from (A's shared/privacy/consent.ts, main/privacy/gate.ts). */
export const GATES = new Set(['requireConsent', 'allowed', 'egressAllowed'])
const GATE_MODULE = /(^|\/)privacy\/(gate|consent)(\.ts)?$/

/**
 * The features a file gates: each string literal inside the arguments of a call to
 * `requireConsent(…)`, `allowed(…)` or `egressAllowed(…)`, whether the gate is imported from
 * privacy/gate or privacy/consent, or injected and called as a member (`deps.allowed('updates')`).
 * A local function that merely shares a gate's name does not count.
 */
export function gatedFeatures(file: string, text: string): Set<string> {
  const sf = parse(file, text)
  const imported = new Set<string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !GATE_MODULE.test(st.moduleSpecifier.text)) continue
    const nb = st.importClause?.namedBindings
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (GATES.has((e.propertyName ?? e.name).text)) imported.add(e.name.text)
  }
  const features = new Set<string>()
  const literals = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) features.add(node.text)
    ts.forEachChild(node, literals)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = node.expression
      const gate = (ts.isIdentifier(c) && imported.has(c.text)) || (ts.isPropertyAccessExpression(c) && GATES.has(c.name.text))
      if (gate) for (const a of node.arguments) literals(a)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return features
}

/** egress.json's two features that are not a ConsentFeature. */
export const LITERALS = ['user-action', 'neutralised'] as const
export interface EgressEntry {
  feature: string
  reason: string
  gatedIn?: string
}

/** egress.json's entries, `$` keys dropped; a malformed entry throws with the fix. */
export function egressEntries(text: string = read('tools/guards/allowlists/egress.json')): Record<string, EgressEntry> {
  const out: Record<string, EgressEntry> = {}
  for (const [file, value] of Object.entries(JSON.parse(text) as Record<string, unknown>)) {
    if (file.startsWith('$')) continue
    const e = value as Partial<EgressEntry>
    if (typeof e.feature !== 'string' || e.feature === '') throw new Error(`egress.json: "${file}" needs a feature (a ConsentFeature, 'user-action' or 'neutralised')`)
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) throw new Error(`egress.json: "${file}" needs a reason (a sentence saying what leaves the machine, to whom)`)
    if (e.gatedIn !== undefined && typeof e.gatedIn !== 'string') throw new Error(`egress.json: "${file}": gatedIn is a repo path`)
    out[file] = { feature: e.feature, reason: e.reason, ...(e.gatedIn === undefined ? {} : { gatedIn: e.gatedIn }) }
  }
  return out
}
