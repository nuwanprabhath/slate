// Usage: node scripts/verify-mac-app.mjs <Slate.app>
// A macOS app whose signature does not verify can crash with a dialog on the user's screen, so
// callers launch only after this exits 0. It ad-hoc signs once if the first check fails.
import { spawnSync } from 'node:child_process'

const app = process.argv[2]
if (!app) {
  console.error('usage: verify-mac-app.mjs <path-to-Slate.app>')
  process.exit(2)
}
const verify = () => spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })

let result = verify()
if (result.status !== 0) {
  console.error(`signature check failed, ad-hoc signing: ${result.stderr.trim()}`)
  spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  result = verify()
}
if (result.status !== 0) {
  console.error(`app does not verify: ${result.stderr.trim()}`)
  process.exit(1)
}
console.log('app signature verifies')
