// electron-builder configuration. Every build runs with --publish never: the release workflow
// uploads the installers and latest-*.yml, and `publish` here only tells the app where its
// update feed is (it becomes resources/app-update.yml).

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.slate.notes',
  productName: 'Slate',
  copyright: 'Copyright © 2026 Nuwan Munasinghe',
  // package.json holds a range (^45.0.0); electron-builder needs the exact release to download. Keep in step with the lockfile.
  electronVersion: '45.0.0',
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**', 'resources/**', 'package.json'],
  // better-sqlite3's .node is loaded from app.asar.unpacked, which onlyLoadAppFromAsar allows: that fuse only governs where the app's entry point comes from.
  asarUnpack: ['**/*.node'],
  // Both sit beside app.asar, outside it, so the asar fuses do not touch them.
  extraResources: [{ from: 'launchers', to: 'bin' }, { from: 'resources/bin', to: 'converter' }],
  publish: { provider: 'github', owner: 'nuwanprabhath', repo: 'slate' },
  electronFuses: {
    // The slate-mcp launcher runs the app binary as Node (ELECTRON_RUN_AS_NODE), so this one stays on.
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    // Playwright attaches to Electron through --inspect; without it e2e-packaged cannot launch the build.
    enableNodeCliInspectArguments: true,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // Flipping fuses invalidates the ad-hoc signature of an unsigned mac build; without a fresh one Apple Silicon refuses to launch it.
    resetAdHocDarwinSignature: true,
  },
  mac: {
    category: 'public.app-category.productivity',
    // Arch comes from the script: dist:mac:arm64 (what CI releases) or dist:mac:x64.
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    // Unsigned: no identity, so electron-builder signs ad hoc and skips notarisation.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  win: { target: 'nsis', icon: 'build/icon.ico' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: {
    target: [
      { target: 'deb', arch: ['x64'] },
      { target: 'AppImage', arch: ['x64'] },
    ],
    icon: 'build/icons',
    category: 'Office',
    maintainer: 'Nuwan Munasinghe <nuwanprabhath@gmail.com>',
    executableName: 'slate',
  },
  deb: {
    afterInstall: 'build/linux-after-install.sh',
    // pickInstaller looks for amd64 in the name; the release workflow adds this file to latest-linux.yml.
    artifactName: 'Slate-${version}-linux-amd64.${ext}',
  },
  artifactName: 'Slate-${version}-${os}-${arch}.${ext}',
  npmRebuild: true,
}
