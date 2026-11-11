// TypeScript's JavaScript compiler API, for the guard tests that read source as an AST.
//
// It comes from this folder's own install, not the root one: the repo's `tsc` is TypeScript 7, which
// ships no JavaScript compiler API (see index.mjs). tools/lint already needs TypeScript 6 for
// typescript-eslint, so the parser the guards use is the one the lint already runs.
export { default as ts } from 'typescript'
