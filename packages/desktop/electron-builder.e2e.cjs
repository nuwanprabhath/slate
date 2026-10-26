// The build e2e-packaged launches (npm run dist:e2e): the release configuration, except that
// Playwright needs --inspect to attach. Never publish what this produces.
const release = require('./electron-builder.cjs')

/** @type {import('electron-builder').Configuration} */
module.exports = { ...release, electronFuses: { ...release.electronFuses, enableNodeCliInspectArguments: true } }
