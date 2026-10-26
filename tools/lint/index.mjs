// The lint toolchain, re-exported from its own install (tools/lint/node_modules).
//
// It lives apart from the root install because typescript-eslint needs TypeScript's JavaScript
// compiler API, which TypeScript 7 (the repo's `tsc`) does not ship: npm cannot hoist
// typescript-eslint next to TypeScript 7, so tools/lint has its own package.json, lockfile and
// TypeScript 6. The root `postinstall` installs it (`npm ci --prefix tools/lint`).
// eslint.config.mjs, the rule tests and dependency-cruiser import everything through this file.
export { default as js } from '@eslint/js'
export { default as tseslint } from 'typescript-eslint'
export { default as reactHooks } from 'eslint-plugin-react-hooks'
export { default as vitest } from '@vitest/eslint-plugin'
export { default as globals } from 'globals'
export { default as eslintComments } from '@eslint-community/eslint-plugin-eslint-comments'
export { defineConfig, globalIgnores } from 'eslint/config'
export { ESLint, Linter, RuleTester } from 'eslint'
