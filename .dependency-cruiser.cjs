// Layers, checked on the resolved module graph (npm run lint:arch). The ESLint `slate/*` boundary
// rules give the same answer per file while you type; this catches what they cannot see: a path
// reached through a re-export, a `require`, or another package's import.
const BRIDGE = 'the renderer reaches the disk and network only through window.slate (src/shared/api.ts); see docs/architecture/golden-paths.md#ipc'
const NODE = { dependencyTypes: ['core'] }

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-stays-pure',
      comment: 'packages/core is loaded by the renderer, main, MCP and sync: no React, DOM, Electron, Node or other @slate package.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { pathNot: '^packages/core/src', dependencyTypesNot: ['type-only'], path: '^(packages/(?!core/)|node_modules/(react|react-dom|electron|@tiptap)/)' },
    },
    {
      name: 'core-no-node',
      comment: 'packages/core: no Node built-ins.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: NODE,
    },
    {
      name: 'editor-stays-in-the-renderer',
      comment: `packages/editor: no Electron, Node or desktop code; ${BRIDGE}`,
      severity: 'error',
      from: { path: '^packages/editor/src' },
      to: { path: '^(packages/desktop/|node_modules/electron/)' },
    },
    {
      name: 'editor-no-node',
      comment: 'packages/editor: no Node built-ins.',
      severity: 'error',
      from: { path: '^packages/editor/src' },
      to: NODE,
    },
    {
      name: 'renderer-through-bridge',
      comment: `No Electron, Node, main or preload in the renderer: ${BRIDGE}`,
      severity: 'error',
      from: { path: '^packages/desktop/src/renderer' },
      to: { path: '^(packages/desktop/src/(main|preload)/|node_modules/electron/)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'renderer-no-node',
      comment: `No Node built-ins in the renderer: ${BRIDGE}`,
      severity: 'error',
      from: { path: '^packages/desktop/src/renderer' },
      to: NODE,
    },
    {
      name: 'main-never-imports-renderer',
      comment: 'Main must not import renderer code; move what both need to src/shared/.',
      severity: 'error',
      from: { path: '^packages/desktop/src/main' },
      to: { path: '^packages/desktop/src/renderer/' },
    },
    {
      name: 'shared-runs-everywhere',
      comment: 'src/shared is loaded by main, preload and renderer: no Electron, no imports from their folders.',
      severity: 'error',
      from: { path: '^packages/desktop/src/shared' },
      to: { path: '^(packages/desktop/src/(main|renderer|preload)/|node_modules/electron/)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'shared-no-node',
      comment: 'src/shared runs in the renderer too, which has no Node.',
      severity: 'error',
      from: { path: '^packages/desktop/src/shared', pathNot: '\\.test\\.ts$' },
      to: NODE,
    },
    {
      name: 'preload-electron-and-shared',
      comment: 'The preload imports electron and src/shared/ only (types from anywhere).',
      severity: 'error',
      from: { path: '^packages/desktop/src/preload' },
      to: { pathNot: '^(packages/desktop/src/(preload|shared)/|node_modules/electron/)', dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.tsx?$|/test/|/e2e/|/e2e-packaged/|\\.d\\.ts$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'], extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] },
  },
}
