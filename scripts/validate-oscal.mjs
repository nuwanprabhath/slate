#!/usr/bin/env node
// Validates the OSCAL component definition(s) under docs/compliance/oscal against NIST's OSCAL 1.2.3 component
// JSON Schema (audit §7.3 C10, V-9). The schema is downloaded from the NIST release and refused unless its
// SHA-256 is the pinned one, so a changed or substituted schema never decides what "valid" means.
//
//   node scripts/validate-oscal.mjs [--schema <local file>] [document.json ...]
//
// `--schema` skips the download (still checked against the pin), for offline runs.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export const OSCAL_VERSION = '1.2.3'
export const SCHEMA_SHA256 = '95e76881151ececd5cb1a93ff0f70ad74b8cc1aa58771626ac8b262bf2c8e001'
export const SCHEMA_URL = `https://github.com/usnistgov/OSCAL/releases/download/v${OSCAL_VERSION}/oscal_component_schema.json`

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function checkPinned(bytes) {
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== SCHEMA_SHA256) throw new Error(`oscal_component_schema.json has SHA-256 ${got}, not the pinned ${SCHEMA_SHA256}`)
}

/** Errors of `doc` under `schema`, as text lines; empty when it is valid. */
export function validate(schema, doc) {
  const ajv = new Ajv({ strict: false, allErrors: true })
  addFormats(ajv)
  const check = ajv.compile(schema)
  return check(doc) ? [] : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)
}

async function schemaBytes(localPath) {
  if (localPath) return readFileSync(localPath)
  const res = await fetch(SCHEMA_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`downloading ${SCHEMA_URL}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main(argv) {
  const args = [...argv]
  let local
  const si = args.indexOf('--schema')
  if (si >= 0) local = args.splice(si, 2)[1]
  const dir = join(ROOT, 'docs/compliance/oscal')
  const docs = args.length > 0 ? args : readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
  const bytes = await schemaBytes(local)
  checkPinned(bytes)
  const schema = JSON.parse(bytes.toString('utf8'))
  let bad = 0
  for (const file of docs) {
    const errors = validate(schema, JSON.parse(readFileSync(file, 'utf8')))
    if (errors.length > 0) {
      bad++
      console.error(`${file}: invalid against OSCAL ${OSCAL_VERSION}\n  ${errors.slice(0, 20).join('\n  ')}`)
    } else console.log(`${file}: valid OSCAL ${OSCAL_VERSION} component definition`)
  }
  if (docs.length === 0) throw new Error('no OSCAL documents found')
  process.exitCode = bad > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e instanceof Error ? e.message : e))
    process.exitCode = 1
  })
}
