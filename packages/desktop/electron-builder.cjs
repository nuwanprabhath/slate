// electron-builder configuration. Every build runs with --publish never: the release workflow
// uploads the installers and latest-*.yml, and `publish` here only tells the app where its
// update feed is (it becomes resources/app-update.yml).
//
// Signing (D-1) switches on from the environment and is off without it: a Developer ID certificate
// in CSC_LINK (or CSC_NAME) signs with the hardened runtime, and Apple notarisation credentials
// (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
// APPLE_TEAM_ID) notarise on top. Without a certificate the mac build stays ad-hoc signed.

const env = process.env
const macCertificate = Boolean(env.CSC_LINK || env.CSC_NAME)
const appleCredentials =
  Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)

const { beforePack } = require('./scripts/prepare-native.cjs')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.slate.notes',
  productName: 'Slate',
  copyright: 'Copyright © 2026 Nuwan Munasinghe',
  // package.json holds a range (^45.0.0); electron-builder needs the exact release to download. Keep in step with the lockfile.
  electronVersion: '45.0.0',
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**', 'resources/**', 'package.json'],
  // slate_native.node (the crypto module with SQLCipher inside, out/native) is loaded from app.asar.unpacked, which onlyLoadAppFromAsar allows: that fuse only governs where the app's entry point comes from.
  asarUnpack: ['**/*.node'],
  // These sit beside app.asar, outside it, so the asar fuses do not touch them. The FIPS provider
  // and its fipsmodule.cnf must be outside: OpenSSL loads them by path (audit §4.9).
  extraResources: [
    { from: 'launchers', to: 'bin' },
    { from: 'resources/bin', to: 'converter' },
    { from: '../native/fips/${platform}-${arch}', to: 'fips' },
    // OpenSSL (Apache-2.0), SQLCipher (BSD-3) and the vendored better-sqlite3 binding (MIT) require their notices.
    { from: '../native/licenses', to: 'licenses' },
  ],
  // Audit C2: a package always carries @slate/native and its FIPS provider for its own target.
  beforePack,
  publish: { provider: 'github', owner: 'nuwanprabhath', repo: 'slate' },
  electronFuses: {
    // The slate-mcp launcher runs the app binary as Node (ELECTRON_RUN_AS_NODE), so this one stays on
    // until slate-mcp ships as its own executable (POA&M in docs/compliance/poam.md).
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    // Release builds refuse --inspect; e2e-packaged builds with electron-builder.e2e.cjs, which turns it on for Playwright.
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // The renderer is served from app://slate/ (src/main/appProtocol.ts), so file:// needs no extra privileges.
    grantFileProtocolExtraPrivileges: false,
    // Flipping fuses invalidates the ad-hoc signature of an unsigned mac build; without a fresh one Apple Silicon refuses to launch it.
    resetAdHocDarwinSignature: true,
  },
  mac: {
    category: 'public.app-category.productivity',
    // Arch comes from the script: dist:mac:arm64 (what CI releases) or dist:mac:x64.
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    // No certificate: identity null, so electron-builder signs ad hoc and cannot notarise. The hardened
    // runtime stays off then: with an ad-hoc signature it enforces library validation, and the
    // unsigned native modules would not load. undefined lets electron-builder take CSC_LINK / CSC_NAME.
    identity: macCertificate ? undefined : null,
    hardenedRuntime: macCertificate,
    // No com.apple.security.get-task-allow in either file: nothing may attach a debugger to a release.
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: macCertificate && appleCredentials,
    gatekeeperAssess: false,
    // Review R1: never re-sign the FIPS provider. Its SHA-256 is pinned in slate_native.node and its
    // module-mac in fipsmodule.cnf; a new signature changes both, and the app would refuse to start.
    // Under a Developer ID the hardened runtime's library validation then needs the provider signed
    // by the same team BEFORE fipsinstall and pinned (POAM-07); release.yml's smoke check fails the
    // release until that is done.
    signIgnore: ['/Contents/Resources/fips/'],
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
