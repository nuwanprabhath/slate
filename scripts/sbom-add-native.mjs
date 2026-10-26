// Adds the native components (OpenSSL, its FIPS provider, SQLCipher) to the CycloneDX SBOM that
// `npx @cyclonedx/cyclonedx-npm` wrote from package-lock.json, which cannot see them.
// Usage: node scripts/sbom-add-native.mjs <sbom.json> [components.json ...]
// Default input: packages/native/sbom-components.json, written by the native build (C2/C3): a JSON
// array of CycloneDX components, each with name, version and at least one hash. Missing file: no-op.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [sbomPath, ...inputs] = process.argv.slice(2)
if (!sbomPath) {
  console.error('usage: sbom-add-native.mjs <sbom.json> [components.json ...]')
  process.exit(2)
}
const sources = inputs.length ? inputs : [join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'native', 'sbom-components.json')]

const bom = JSON.parse(readFileSync(sbomPath, 'utf8'))
bom.components ??= []
let added = 0
for (const file of sources) {
  if (!existsSync(file)) {
    console.log(`no ${file}: no native components to add`)
    continue
  }
  const components = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(components)) throw new Error(`${file} is not a JSON array of components`)
  for (const c of components) {
    if (!c?.name || !c?.version || !Array.isArray(c.hashes) || c.hashes.length === 0) throw new Error(`${file}: every component needs name, version and hashes (${JSON.stringify(c?.name)})`)
    const ref = c['bom-ref'] ?? `native|${c.name}@${c.version}`
    if (bom.components.some((x) => x['bom-ref'] === ref)) continue
    bom.components.push({ type: 'library', ...c, 'bom-ref': ref })
    added++
  }
}
writeFileSync(sbomPath, JSON.stringify(bom, null, 2) + '\n')
console.log(`added ${added} native components to ${sbomPath}`)
