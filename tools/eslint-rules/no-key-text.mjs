// @ts-check

/**
 * `slate/no-key-text` (type-aware): a `KeyBytes` value (src/main/vault/keyring.ts) never becomes
 * text. Its type already refuses `toString` and `toJSON`; this catches the conversions a type
 * cannot: a template literal, `String(k)`, `JSON.stringify(…k…)` and `'…' + k` (audit Z-2,
 * T-STATIC-01). Without type information (the per-edit hook) it does nothing.
 */
const KEY_TYPE = /\bKeyBytes\b/

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'KeyBytes never becomes text.' },
    messages: {
      text: 'This turns key bytes into text (audit Z-2). Pass the KeyBytes to the primitive that needs it (src/main/vault/envelope.ts, names.ts, header.ts: @slate/native takes key handles) and zero it with fill(0); never log, print, stringify or interpolate it.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {}
    const checker = services.program.getTypeChecker()
    /** A KeyBytes value, or an object literal with one inside (JSON.stringify({ mk })). */
    const isKey = (/** @type {any} */ node) => {
      if (node.type === 'ObjectExpression') return node.properties.some((/** @type {any} */ p) => p.type === 'Property' && isKey(p.value))
      return KEY_TYPE.test(checker.typeToString(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))))
    }
    const report = (/** @type {any} */ node) => context.report({ node, messageId: 'text' })
    return {
      TemplateLiteral(node) {
        for (const e of node.expressions) if (isKey(e)) report(e)
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node.callee)
        const isString = callee.type === 'Identifier' && callee.name === 'String'
        const isJson = callee.type === 'MemberExpression' && callee.object.name === 'JSON' && callee.property.name === 'stringify'
        if ((isString || isJson) && node.arguments[0] && isKey(node.arguments[0])) report(node.arguments[0])
      },
      BinaryExpression(node) {
        if (node.operator !== '+') return
        for (const side of [node.left, node.right]) if (side.type !== 'PrivateIdentifier' && isKey(side)) report(side)
      },
    }
  },
}
