// @ts-check

/**
 * `slate/secret-bytes-stay-bytes` (audit Z-5, C7; review C7 L2): a typed password or recovery key is
 * `SecretBytes` (src/shared/secret.ts, a branded Uint8Array) and never becomes text. Type-aware: an
 * expression is a secret when its type is `SecretBytes` (a parameter, a `VaultSecret` member, a
 * `passwordBytes` result), or it is `new Uint8Array(…)`, `Uint8Array.from(…)`, `.slice()`/`.subarray()`
 * or `Buffer.from(…)` of one. Reported: `TextDecoder#decode`, `String.fromCharCode`, `.toString()`,
 * `String()`, `JSON.stringify`, a template literal, `+` with a string, and `Buffer.from` (whose
 * `toString` is one call away), `String.fromCodePoint`, `.join`, `Array.from` and spreading it into an
 * array. Because a helper or a wider type loses the brand (re-review C7 L), handing a secret to a
 * parameter, variable or assignment not typed `SecretBytes`/`VaultSecret` is reported too; the
 * sanctioned hand-offs are the module (`SlateNative`, given its own copy) and `ipcRenderer.invoke`.
 * The one residual, `checkPassword` (vault/password.ts), is the rule's only allowed file.
 */
const SECRET_TYPE = /\b(SecretBytes|VaultSecret)\b/

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'A typed secret (SecretBytes) is never turned into text.' },
    messages: {
      text:
        'Do not turn a typed secret into text ({{how}}): keep it `SecretBytes` from the field to the module and zero it when the call settles ' +
        '(src/shared/secret.ts; docs/architecture/golden-paths.md#a-typed-password-or-recovery-key). A V8 string cannot be zeroed (audit Z-5, Z-11); ' +
        'the only place a password becomes text is `checkPassword` (vault/password.ts), for the policy.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices
    const typed = services?.program && services.esTreeNodeToTSNodeMap
    const typeOf = (/** @type {any} */ node) => {
      if (!typed) return ''
      const checker = services.program.getTypeChecker()
      return checker.typeToString(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)))
    }
    /** @returns {boolean} */
    const isSecret = (/** @type {any} */ n) => {
      if (!n) return false
      if (n.type === 'SpreadElement') return isSecret(n.argument)
      if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'ChainExpression') return isSecret(n.expression)
      if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && /^(Uint8Array|Buffer)$/.test(n.callee.name)) return isSecret(n.arguments[0])
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.type === 'Identifier') {
        const m = n.callee.property.name
        if ((m === 'slice' || m === 'subarray') && isSecret(n.callee.object)) return true
        if (m === 'from' && n.callee.object.type === 'Identifier' && /^(Uint8Array|Buffer)$/.test(n.callee.object.name)) return isSecret(n.arguments[0])
      }
      // The value itself is a secret (possibly `| null` before narrowing), not an object or function that mentions one.
      return /^SecretBytes(\s*\|\s*(null|undefined))*$/.test(typeOf(n))
    }
    const report = (/** @type {any} */ node, /** @type {string} */ how) => context.report({ node, messageId: 'text', data: { how } })
    /** The declared type of the parameter argument `i` of `call` lands in ('' without type information). */
    const paramType = (/** @type {any} */ call, /** @type {number} */ i) => {
      if (!typed) return ''
      const checker = services.program.getTypeChecker()
      const tsNode = services.esTreeNodeToTSNodeMap.get(call)
      const sig = checker.getResolvedSignature(tsNode)
      const params = sig?.getParameters() ?? []
      if (params.length === 0) return 'no parameter'
      return checker.typeToString(checker.getTypeOfSymbolAtLocation(params[Math.min(i, params.length - 1)], tsNode))
    }
    /** The module and IPC take secret bytes by design: the module wipes its copy, IPC carries them to main. */
    const sanctionedSink = (/** @type {any} */ callee) =>
      callee.type === 'MemberExpression' &&
      ((callee.object.type === 'Identifier' && callee.object.name === 'ipcRenderer') || /\bSlateNative\b/.test(typeOf(callee.object)))
    /** A hand-off to something not typed as a secret: a parameter, a variable, an assignment. */
    const handOff = (/** @type {any} */ node) => {
      if (!typed) return
      node.arguments.forEach((/** @type {any} */ a, /** @type {number} */ i) => {
        if (a.type === 'SpreadElement' || !isSecret(a) || sanctionedSink(node.callee)) return
        const t = paramType(node, i)
        if (!SECRET_TYPE.test(t)) report(a, `passed to a parameter typed ${t}`)
      })
    }
    return {
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee)
        const args = /** @type {any[]} */ (node.arguments)
        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
          const m = callee.property.name
          if (m === 'decode' && isSecret(args[0])) return report(node, 'TextDecoder.decode')
          if (m === 'toString' && isSecret(callee.object)) return report(node, '.toString()')
          if (m === 'join' && isSecret(callee.object)) return report(node, '.join()')
          if (callee.object.type === 'Identifier') {
            if (callee.object.name === 'String' && (m === 'fromCharCode' || m === 'fromCodePoint') && args.some(isSecret)) return report(node, `String.${m}`)
            if (callee.object.name === 'Array' && m === 'from' && isSecret(args[0])) return report(node, 'Array.from')
            if (callee.object.name === 'JSON' && m === 'stringify' && isSecret(args[0])) return report(node, 'JSON.stringify')
            if (callee.object.name === 'Buffer' && m === 'from' && isSecret(args[0])) return report(node, 'Buffer.from')
          }
        }
        if (callee.type === 'Identifier' && callee.name === 'String' && isSecret(args[0])) return report(node, 'String()')
        handOff(node)
      },
      ArrayExpression(node) {
        if (node.elements.some((/** @type {any} */ e) => e?.type === 'SpreadElement' && isSecret(e.argument))) report(node, 'spreading it into an array')
      },
      VariableDeclarator(node) {
        const id = /** @type {any} */ (node.id)
        if (typed && id.typeAnnotation && isSecret(node.init) && !SECRET_TYPE.test(typeOf(id))) report(node, `a variable typed ${typeOf(id)}`)
      },
      AssignmentExpression(node) {
        if (typed && isSecret(node.right) && !SECRET_TYPE.test(typeOf(node.left))) report(node, `an assignment to ${typeOf(node.left)}`)
      },
      TemplateLiteral(node) {
        if (node.expressions.some(isSecret)) report(node, 'a template literal')
      },
      BinaryExpression(node) {
        if (node.operator === '+' && (isSecret(node.left) || isSecret(node.right))) report(node, '+')
      },
    }
  },
}
