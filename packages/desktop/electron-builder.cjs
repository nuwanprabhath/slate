// electron-builder configuration. A .cjs (not .yml) so auto-update can be switched on by an
// environment variable at build time: with SLATE_UPDATE_URL set, the build publishes a generic
// feed and ships resources/update.json (read by src/main/updates.ts); without it neither exists.
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const updateUrl = (process.env.SLATE_UPDATE_URL ?? '').trim()
const generated = join(__dirname, '.generated')
rmSync(generated, { recursive: true, force: true })
if (updateUrl) {
  mkdirSync(generated, { recursive: true })
  writeFileSync(join(generated, 'update.json'), JSON.stringify({ url: updateUrl }))
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.slate.notes',
  productName: 'Slate',
  copyright: 'Copyright © 2026 Nuwan Munasinghe',
  // package.json holds a range (^45.0.0); electron-builder needs the exact release to download. Keep in step with the lockfile.
  electronVersion: '45.0.0',
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**', 'resources/**', 'package.json'],
  asarUnpack: ['**/*.node'],
  extraResources: [{ from: 'launchers', to: 'bin' }, { from: 'resources/bin', to: 'converter' }, ...(updateUrl ? [{ from: '.generated/update.json', to: 'update.json' }] : [])],
  ...(updateUrl ? { publish: { provider: 'generic', url: updateUrl } } : {}),
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
  },
  win: { target: 'nsis', icon: 'build/icon.ico' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ['AppImage', 'deb'], icon: 'build/icons', category: 'Office', maintainer: 'Nuwan Munasinghe' },
  artifactName: 'Slate-${version}-${os}-${arch}.${ext}',
  npmRebuild: true,
}
