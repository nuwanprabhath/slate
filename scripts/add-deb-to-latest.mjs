// electron-builder lists only the AppImage in latest-linux.yml. The app's assisted .deb update
// (packages/desktop/src/main/update) picks its file and checks its sha512 from that list, so the
// release workflow adds the .deb after `dist:linux`. Usage: node scripts/add-deb-to-latest.mjs <release dir>
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'packages/desktop/release'
const yml = join(dir, 'latest-linux.yml')
const debs = readdirSync(dir).filter((f) => f.endsWith('.deb'))
if (debs.length === 0) throw new Error(`no .deb in ${dir}`)

let text = readFileSync(yml, 'utf8')
if (!/^files:\n/m.test(text)) throw new Error(`${yml} has no files: list`)
for (const deb of debs) {
  if (text.includes(`url: ${deb}\n`)) continue
  const bytes = readFileSync(join(dir, deb))
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const entry = `  - url: ${deb}\n    sha512: ${sha512}\n    size: ${statSync(join(dir, deb)).size}\n`
  text = text.replace(/^files:\n/m, (m) => m + entry)
}
writeFileSync(yml, text)
console.log(`added ${debs.join(', ')} to ${yml}`)
