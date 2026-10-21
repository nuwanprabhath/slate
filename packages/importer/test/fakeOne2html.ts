import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUTPUT = join(__dirname, 'fixtures/one2html')

/**
 * A stand-in for the one2html binary that copies the committed converter output for the fixture
 * into --output, whatever the input. For tests that need to run the converter as a child process
 * on machines without the real binary (it is Rust, built separately). POSIX shell only.
 */
export function writeFakeConverter(dir: string, output = OUTPUT): string {
  const file = join(dir, 'fake-one2html')
  writeFileSync(file, `#!/bin/sh\nwhile [ "$1" != "--output" ] && [ $# -gt 0 ]; do shift; done\ncp -R '${output}/.' "$2"\n`)
  chmodSync(file, 0o755)
  return file
}
