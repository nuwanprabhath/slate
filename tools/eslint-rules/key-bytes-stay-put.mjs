// @ts-check

/**
 * `slate/key-bytes-stay-put`: key material is never copied into new memory by `Buffer.concat`,
 * `Buffer.from`, `Buffer.copyBytesFrom` or `Uint8Array.from` (audit Z-2, Z-j). Those copies land in
 * Node's shared pool slab or in a buffer nobody owns, so nobody zeroes them.
 *
 * An operand is key material when:
 * - its type is the KeyRing's branded `KeyBytes` (type-aware), or
 * - its name is a key name (the T-STATIC-01 pattern: mk, lk, kek, key, secret, qu, password), or
 * - it is the `update()`/`final()` output of a decipher (typed `Decipher*`, or a receiver named
 *   like one): the plaintext of a key wrap is the key itself (review phase11-c1, `gcmOpen`).
 *
 * Copy key bytes with `copyKey` (src/main/vault/keyring.ts) and assemble decipher output into a
 * `Buffer.alloc` destination, zeroing each part in `finally` (vault/crypto.ts `gcmOpen`).
 */
const KEY_NAME = /(^|_)(mk|lk|kek|key|secret|qu|password)($|[A-Z_])/i
const COPIERS = new Map([
  ['Buffer', new Set(['concat', 'from', 'copyBytesFrom'])],
  ['Uint8Array', new Set(['from'])],
])

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Key bytes are never copied with Buffer.concat/from/copyBytesFrom or Uint8Array.from.' },
    messages: {
      copy:
        'Do not copy key material with {{how}}: copy it with `copyKey(src)` (src/main/vault/keyring.ts) and zero the copy in `finally`; ' +
        'assemble decipher output into a `Buffer.alloc` destination and zero each part (vault/crypto.ts `gcmOpen`). ' +
        "A pooled or unowned copy of a key is never zeroed (audit Z-2, Z-j; docs/architecture/golden-paths.md#keys-and-crypto).",
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
    const lastName = (/** @type {any} */ n) =>
      n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier' ? n.property.name : ''
    /** @returns {boolean} */
    const isKey = (/** @type {any} */ n) => {
      if (!n) return false
      if (n.type === 'SpreadElement') return isKey(n.argument)
      if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') return isKey(n.expression)
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
        const method = lastName(n.callee)
        if (method === 'update' || method === 'final') {
          const recv = n.callee.object
          return /decipher/i.test(lastName(recv)) || /\bDecipher/.test(typeOf(recv))
        }
        // keyRing.get('mk') hands out KeyBytes.
        if (method === 'get' && /\bKeyBytes\b/.test(typeOf(n))) return true
        return false
      }
      if (KEY_NAME.test(lastName(n))) return true
      return /\bKeyBytes\b/.test(typeOf(n))
    }
    const calleeOf = (/** @type {any} */ callee) => {
      if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return null
      const method = callee.computed ? (callee.property.type === 'Literal' ? String(callee.property.value) : '') : callee.property.name
      return COPIERS.get(callee.object.name)?.has(method) ? `${callee.object.name}.${method}` : null
    }
    return {
      CallExpression(node) {
        const how = calleeOf(node.callee)
        if (!how) return
        const first = /** @type {any} */ (node.arguments[0])
        // Decoding text (`Buffer.from(s, 'base64')`) makes bytes from a string, not a copy of key bytes.
        if (how.endsWith('.from') && node.arguments.length > 1 && /^string\b/.test(typeOf(first))) return
        const operands = how === 'Buffer.concat' ? (first?.type === 'ArrayExpression' ? first.elements : [first]) : [first]
        if (operands.some(isKey)) context.report({ node, messageId: 'copy', data: { how } })
      },
    }
  },
}
