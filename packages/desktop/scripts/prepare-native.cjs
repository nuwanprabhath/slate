// electron-builder's beforePack hook (audit C2): a package always carries @slate/native and its FIPS
// provider for its own target. Its own module, so every load of electron-builder.cjs (and the e2e
// config built from it) references the same function.
const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('electron-builder')

const desktop = join(__dirname, '..')

/** Puts the target's slate_native.node at out/native (see electron.vite.config.ts) and checks the provider is built. */
function prepareNative(platform, arch) {
  const target = `${platform}-${arch}`
  const native = join(desktop, '..', 'native')
  const addon = join(native, 'prebuilds', target, 'slate_native.node')
  const provider = join(native, 'fips', target, platform === 'darwin' ? 'fips.dylib' : 'fips.so')
  for (const file of [addon, provider, join(native, 'fips', target, 'fipsmodule.cnf')]) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm run -w @slate/native build -- --target ${target}\` before packaging`)
  }
  mkdirSync(join(desktop, 'out', 'native'), { recursive: true })
  copyFileSync(addon, join(desktop, 'out', 'native', 'slate_native.node'))
}

/** @param {import('electron-builder').BeforePackContext} context */
function beforePack(context) {
  prepareNative(context.electronPlatformName, Arch[context.arch])
}

module.exports = { beforePack, prepareNative }
