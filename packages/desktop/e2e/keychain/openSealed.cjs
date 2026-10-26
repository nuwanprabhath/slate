// Run by safeStorageMigration.keychain.ts with Electron directly: Playwright's launcher adds --use-mock-keychain,
// which never sees the maintainer's Keychain item "Slate Safe Storage" that sealed the fixture.
const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
app.setName('Slate')
app.whenReady().then(async () => {
  const { sealedBase64 } = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'))
  try {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(sealedBase64, 'base64'))
    process.stdout.write(`OPENED ${JSON.stringify(result)}\n`)
  } catch (e) {
    process.stdout.write(`FAILED ${String(e)}\n`)
  }
  app.exit(0)
})
