// @ts-check

/**
 * `slate/sql-text-is-literal`: the SQL handed to better-sqlite3 (`db.prepare`, `db.exec`,
 * `db.pragma`) is a string literal or a template literal without `${}`. Values go in as `?`
 * parameters; text built at run time is how a note title or a key ends up inside SQL. The files that
 * must build SQL (a closed set of column names, a key pragma) are reviewed entries of
 * tools/guards/allowlists/sql-dynamic.json, passed as the `allow` option by eslint.config.mjs.
 *
 * Type-aware: only receivers whose type is better-sqlite3's `Database` or `Statement` count, so
 * `RegExp.exec` and `migration.prepare` are not SQL.
 */
const METHODS = new Set(['prepare', 'exec', 'pragma'])
const SQLITE_TYPE = /\b(Database|Statement)\b/

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'SQL text is a literal; values are parameters.' },
    messages: {
      literal:
        'Write the SQL as a literal and pass values as `?` parameters: `db.prepare(\'SELECT … WHERE id = ?\').get(id)`. ' +
        'If the statement truly varies (a closed set of column names), build it from constants in one reviewed function and list the file, with the reason, in tools/guards/allowlists/sql-dynamic.json; the maintainer reviews that list.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices
    const typed = services?.program && services.esTreeNodeToTSNodeMap
    /** The receiver's last name segment: `db`, `this.db`, `stmt.database`. */
    const nameOf = (/** @type {any} */ object) =>
      object.type === 'Identifier' ? object.name : object.type === 'MemberExpression' && object.property.type === 'Identifier' ? object.property.name : ''
    const namedLikeSql = (/** @type {any} */ object) => /(db|database|stmt|statement)$|^(copy|held)$/i.test(nameOf(object))
    /** SQL when its type is better-sqlite3's, or its name says so: both modes report the same code. */
    const isSqlReceiver = (/** @type {any} */ object) => {
      if (namedLikeSql(object)) return true
      if (!typed) return false
      const checker = services.program.getTypeChecker()
      return SQLITE_TYPE.test(checker.typeToString(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(object))))
    }
    /** Text built at run time that starts as SQL, whatever the receiver is called or typed as. */
    const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH|REPLACE|ATTACH|VACUUM)\b/i
    /** The text the built string starts with: through `+`, `[…].join()`, `.concat()`, `.trim()` and the like (red team G2-9). */
    const leadingText = (/** @type {any} */ arg, depth = 0) => {
      if (!arg || depth > 8) return ''
      if (arg.type === 'Literal') return typeof arg.value === 'string' ? arg.value : ''
      if (arg.type === 'TemplateLiteral') return arg.quasis[0]?.value.cooked ?? ''
      if (arg.type === 'BinaryExpression' && arg.operator === '+') return leadingText(arg.left, depth + 1)
      if (arg.type === 'ArrayExpression') return leadingText(arg.elements[0], depth + 1)
      if (arg.type === 'CallExpression' && arg.callee.type === 'MemberExpression') return leadingText(arg.callee.object, depth + 1)
      return ''
    }
    const looksLikeSql = (/** @type {any} */ arg) => SQL_START.test(leadingText(arg))
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || !METHODS.has(callee.property.name)) return
        const sql = node.arguments[0]
        if (sql === undefined) return
        if (sql.type === 'Literal' && typeof sql.value === 'string') return
        if (sql.type === 'TemplateLiteral' && sql.expressions.length === 0) return
        if (isSqlReceiver(callee.object) || looksLikeSql(sql)) context.report({ node: sql, messageId: 'literal' })
      },
      // `db.prepare.bind(db)(sql)` or a stored `db.exec`: the method leaves the call site, so its text cannot be checked.
      MemberExpression(node) {
        if (node.property.type !== 'Identifier' || !METHODS.has(node.property.name)) return
        const parent = /** @type {any} */ (node).parent
        if (parent?.type === 'CallExpression' && parent.callee === node) return
        if (isSqlReceiver(node.object)) context.report({ node, messageId: 'literal' })
      },
    }
  },
}
