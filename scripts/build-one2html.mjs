// Builds the one2html converter (Rust, MPL-2.0) that turns OneNote backup .one files into HTML, and
// copies it to packages/desktop/resources/bin/. Needs cargo and rustup on PATH (or CARGO_HOME and
// RUSTUP_HOME set). Nightly, because onenote_parser's `backtrace` feature needs it.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '2.0.1'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.platform === 'win32' ? '.exe' : ''
const target = join(root, 'packages/desktop/resources/bin', `one2html-${process.platform}-${process.arch}${exe}`)

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.error?.code === 'ENOENT') {
    console.error(`${cmd} was not found. Install Rust from https://rustup.rs (or set CARGO_HOME and RUSTUP_HOME), then run this again.`)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status ?? 1)
}

const tmp = mkdtempSync(join(tmpdir(), 'one2html-build-'))
try {
  run('rustup', ['toolchain', 'install', 'nightly', '--profile', 'minimal'])
  run('cargo', ['+nightly', 'install', 'one2html', '--version', VERSION, '--root', tmp])
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(tmp, 'bin', `one2html${exe}`), target)
  console.log(target)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
