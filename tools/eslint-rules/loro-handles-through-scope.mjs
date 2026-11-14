// @ts-check
import { allowlist, repoPath } from './paths.mjs'

/**
 * `slate/loro-handles-through-scope` (FX-38): code that runs in core or the main process reads Loro only
 * inside a handle scope. Loro frees nothing of a document while a handle read from it is alive (a
 * `LoroMap`, `LoroList`, `LoroMovableList`, `LoroText`, `LoroTree`, `LoroTreeNode`, `LoroCounter`, or
 * a fork), and an unfreed handle goes only in a finalizer task, so a loop that never awaits keeps every
 * document it opened (FX-30, FX-32, FX-33, FX-35, FX-36, FX-37). The accepted path is `withHandles((h)
 * => …)` with `h.own(<the read>)` (packages/core/src/handles.ts).
 *
 * Type-aware. It reports an expression that makes a handle:
 * - a call or `new` whose type holds a handle class, through unions, arrays, tuples, type arguments and
 *   a type parameter's constraint (`Container | undefined`, `LoroTreeNode[]`, `C extends Container`);
 * - a call of a Loro member typed `unknown`/`any` (`map.get(k)`, `list.toArray()`): a peer can put a
 *   container under any key. The member's declared type counts too, so `LoroMap<{ x: number }>.get('x')`
 *   is still a read. Loro's JSON exports and a map's `keys()` (`DATA_ONLY`) return data and pass;
 * - a member read from a Loro object that holds a handle (`node.data`), also destructured;
 * - `doc.fork()`/`forkAt()`;
 * unless it is the direct argument of `own(`/`keep(` on a `Handles`, or a call that is given the
 * `Handles` (a helper that owns into its caller's scope: `this.boxes(h)`).
 *
 * `keep(` hands a handle out of its scope, so it and a `withHandles` that returns a handle are allowed
 * only inside the functions named in tools/guards/allowlists/loro-handles.json.
 *
 * What a source scan misses, and this catches (FX-36's list, test/handleLifetime.test.ts): an alias
 * (`const g = doc.getMap; g('x')`, `const { own } = h`), a computed member (`doc['getMap']('x')`), a
 * read on another line than its `own(`, a caller outside packages/core that is handed a handle
 * (`page.contentMap(id)`), and a plain `Map.get`, which is no read. A look-alike `own` that is not
 * `Handles`'s does not count.
 *
 * Still blind to: a handle inside an object (`planReplace`'s edits carry texts; the hand-out list is
 * what covers their source), a handle Loro delivers in an event's diff unless a call returns it
 * (`Object.entries(diff.updated)` is seen, `diff.updated[key]` is not; sync's `ownContainers` owns
 * them), `Reflect.get`/`.call`/`.bind` of an `unknown`-typed read, a handle reached through `any`, a
 * `LoroDoc` nobody frees (`new LoroDoc()` is a document, not a handle), and anything outside the
 * rule's files (the editor and the renderer hold handles while a box is open).
 */
const HANDLE_CLASSES = new Set(['LoroMap', 'LoroList', 'LoroMovableList', 'LoroText', 'LoroTree', 'LoroTreeNode', 'LoroCounter'])
const LORO_OBJECTS = new Set([...HANDLE_CLASSES, 'LoroDoc'])
const FORKS = new Set(['fork', 'forkAt'])
/** Loro members typed `any` that return plain data, never a handle: the JSON exports, and a map's keys (strings). */
const DATA_ONLY = new Set(['toJSON', 'getDeepValueWithID', 'keys'])
/** Syntax that changes an expression's type, not its value. */
const TRANSPARENT = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ChainExpression'])

const posix = (/** @type {string} */ file) => file.split('\\').join('/')
const declaredIn = (/** @type {any} */ symbol, /** @type {(file: string) => boolean} */ test) =>
  (symbol?.declarations ?? []).some((/** @type {any} */ d) => test(posix(d.getSourceFile().fileName)))
const inLoro = (/** @type {string} */ file) => file.includes('/node_modules/loro-crdt/')
const inHandles = (/** @type {string} */ file) => file.endsWith('/packages/core/src/handles.ts')

/** @type {Record<string, string[]> | undefined} */
let listed
/** The functions that may hand a handle out, by file: `{ file: { names, reason } }` in the allowlist. */
function handOuts() {
  listed ??= Object.fromEntries(Object.entries(allowlist('loro-handles')).map(([file, entry]) => [file, typeof entry === 'string' ? [] : entry.names]))
  return listed
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Core and the main process read Loro handles only through a handle scope (withHandles, own, keep).' },
    messages: {
      handle:
        'This makes a Loro handle ({{type}}) outside a handle scope: wrap the read itself, `h.own({{text}})`, inside `withHandles((h) => …)` from @slate/core ' +
        '(packages/core/src/handles.ts), or call a core method that returns data (`PageDoc.boxContent`, `agentBoxes`). ' +
        'Loro frees nothing of a document while one handle read from it is alive, whatever calls `free()` (FX-30, FX-33, FX-35 to FX-37).',
      fork:
        'A fork holds memory as a document does, and keeps its source alive: `h.own({{text}})` inside `withHandles((h) => …)` from @slate/core ' +
        '(packages/core/src/handles.ts) frees it when the scope ends, also when it throws (FX-37).',
      keep:
        '`keep(` (or a `withHandles` that returns a handle) hands a Loro handle out of its scope, and every caller must then free it. Only the functions in ' +
        'tools/guards/allowlists/loro-handles.json do that, and only the maintainer adds one: return data instead (`PageDoc.boxContent`), or do the work inside the scope.',
    },
    schema: [{ type: 'object', properties: { handOut: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } }, additionalProperties: false }],
  },
  create(context) {
    const services = context.sourceCode.parserServices
    // No type information (the per-edit fast lint, a file outside every project): nothing to read.
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {}
    const checker = services.program.getTypeChecker()
    const tsNode = (/** @type {any} */ node) => services.esTreeNodeToTSNodeMap.get(node)
    const typeOf = (/** @type {any} */ node) => checker.getTypeAtLocation(tsNode(node))
    const handOut = /** @type {Record<string, string[]>} */ (context.options[0]?.handOut ?? handOuts())[repoPath(context.filename)] ?? []

    /** An instance of a class Loro declares, by its class name; '' for anything else (also `typeof LoroMap`). */
    const loroClass = (/** @type {any} */ type) => {
      const instance = type.isClassOrInterface() || (type.target && type.target !== type && type.target.isClassOrInterface())
      return instance && declaredIn(type.symbol, inLoro) ? String(type.symbol.name) : ''
    }
    const isLoroObject = (/** @type {any} */ type) =>
      type.isUnion() ? type.types.some((/** @type {any} */ t) => LORO_OBJECTS.has(loroClass(t))) : LORO_OBJECTS.has(loroClass(type))

    /**
     * 'handle' when the type holds a handle class, 'opaque' when it could (`unknown`, `any`, an
     * unconstrained type parameter), else ''.
     * @param {any} type @param {Set<any>} [seen] @returns {'handle' | 'opaque' | ''}
     */
    const holds = (type, seen = new Set()) => {
      if (!type || seen.has(type) || seen.size > 200) return ''
      seen.add(type)
      const intrinsic = type.intrinsicName
      if (intrinsic === 'any' || intrinsic === 'unknown' || intrinsic === 'error') return 'opaque'
      /** @param {readonly any[]} types */
      const strongest = (types) => {
        /** @type {'handle' | 'opaque' | ''} */
        let found = ''
        for (const t of types) {
          const one = holds(t, seen)
          if (one === 'handle') return 'handle'
          if (one === 'opaque') found = 'opaque'
        }
        return found
      }
      if (type.isUnionOrIntersection()) return strongest(type.types)
      // A Loro class stops the walk: a LoroDoc's type argument names every container, and holds none.
      const loro = loroClass(type)
      if (loro !== '') return HANDLE_CLASSES.has(loro) ? 'handle' : ''
      if (type.isTypeParameter()) {
        const bound = type.getConstraint()
        return bound ? holds(bound, seen) : 'opaque'
      }
      // `T[Key]`, a conditional type: what it can be at most.
      const constraint = checker.getBaseConstraintOfType(type)
      if (constraint && constraint !== type) return holds(constraint, seen)
      // Anything else Loro declares (a listener, a cursor) is not a handle.
      if (declaredIn(type.symbol, inLoro)) return ''
      return strongest([...(type.target ? checker.getTypeArguments(type) : []), ...(type.aliasTypeArguments ?? [])])
    }

    /** The declaration a call resolves to, with the class or interface that declares it. */
    const resolved = (/** @type {any} */ node) => {
      const declaration = checker.getResolvedSignature(tsNode(node))?.declaration
      const owner = declaration?.parent
      return declaration ? { declaration, name: String(declaration.name?.text ?? ''), owner: String(owner?.name?.text ?? ''), file: posix(declaration.getSourceFile().fileName) } : null
    }
    /** `own` or `keep` of core's `Handles`, however the call spells it. */
    const scopeMethod = (/** @type {any} */ node) => {
      if (node.type !== 'CallExpression') return ''
      const to = resolved(node)
      return to && inHandles(to.file) && to.owner === 'Handles' && (to.name === 'own' || to.name === 'keep') ? to.name : ''
    }
    const isHandles = (/** @type {any} */ type) => type.symbol?.name === 'Handles' && declaredIn(type.symbol, inHandles)

    /** The node whose parent decides: `x`, `x!`, `x as T` and `a?.b()` are one value. */
    const outermost = (/** @type {any} */ node) => {
      while (TRANSPARENT.has(node.parent.type)) node = node.parent
      return node
    }
    const owned = (/** @type {any} */ node) => {
      const value = outermost(node)
      return value.parent.type === 'CallExpression' && value.parent.arguments[0] === value && scopeMethod(value.parent) !== ''
    }
    /** Inside a function the allowlist names as handing a handle out. */
    const handsOut = (/** @type {any} */ node) => {
      for (let n = node.parent; n; n = n.parent) {
        const named = n.type === 'FunctionDeclaration' ? n.id : n.type === 'MethodDefinition' || n.type === 'Property' ? n.key : n.type === 'VariableDeclarator' ? n.id : null
        if (named?.type === 'Identifier' && handOut.includes(named.name)) return true
      }
      return false
    }

    const text = (/** @type {any} */ node) => {
      const source = context.sourceCode.getText(node).replace(/\s+/g, ' ')
      return source.length > 60 ? `${source.slice(0, 57)}…` : source
    }
    /** @param {any} node @param {'handle' | 'fork' | 'keep'} messageId @param {any} [type] */
    const report = (node, messageId, type) => context.report({ node, messageId, data: { text: text(node), type: type ? checker.typeToString(type) : '' } })

    /** @param {any} node */
    const checkCall = (node) => {
      const method = scopeMethod(node)
      if (method === 'keep' && !handsOut(node)) return report(node, 'keep')
      if (method !== '' || owned(node)) return
      const to = node.type === 'CallExpression' ? resolved(node) : null
      const loroMember = to !== null && inLoro(to.file) && LORO_OBJECTS.has(to.owner)
      if (loroMember && to.owner === 'LoroDoc' && FORKS.has(to.name)) return report(node, 'fork')
      const type = typeOf(node)
      // `new Map<string, LoroText>()` makes a place for handles, not a handle.
      let found = node.type === 'NewExpression' ? (HANDLE_CLASSES.has(loroClass(type)) ? 'handle' : '') : holds(type)
      if (found !== 'handle' && loroMember) {
        const declared = checker.getSignatureFromDeclaration(to.declaration)
        const fromDeclaration = declared ? holds(checker.getReturnTypeOfSignature(declared)) : ''
        if (fromDeclaration === 'handle') found = 'handle'
        else if (fromDeclaration === 'opaque') found = 'opaque'
      }
      if (found === '') return
      // `unknown` from anything but a Loro read is not a handle (JSON.parse, a catch clause).
      if (found === 'opaque' && !(loroMember && !DATA_ONLY.has(to.name))) return
      // A helper that is given the scope owns into it, and this rule holds the helper to the same.
      if (found === 'handle' && node.arguments.some((/** @type {any} */ a) => a.type !== 'SpreadElement' && isHandles(typeOf(a)))) return
      if (to !== null && inHandles(to.file) && to.name === 'withHandles') {
        if (!handsOut(node)) report(node, 'keep')
        return
      }
      report(node, 'handle', type)
    }

    return {
      CallExpression: checkCall,
      NewExpression: checkCall,
      MemberExpression: (/** @type {any} */ node) => {
        // A method call is the call's to answer for; an assignment's target reads nothing.
        if ((node.parent.type === 'CallExpression' && node.parent.callee === node) || (node.parent.type === 'AssignmentExpression' && node.parent.left === node)) return
        if (!isLoroObject(typeOf(node.object))) return
        const type = typeOf(node)
        if (holds(type) !== '' && !owned(node)) report(node, 'handle', type)
      },
      ObjectPattern: (/** @type {any} */ node) => {
        if (!isLoroObject(typeOf(node))) return
        for (const property of node.properties) {
          const type = typeOf(property.type === 'RestElement' ? property.argument : property.value)
          if (property.type === 'RestElement' || holds(type) !== '') report(property, 'handle', type)
        }
      },
    }
  },
}
