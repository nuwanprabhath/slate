import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAC_FREE_BYTES_JXA, lowDiskMessage, parseDfFreeKb, parseFreeBytesAsKb } from './diskGuard'

export interface Run {
  code: number | null
  stdout: string
  stderr: string
}

/** The variables a child of the harness must not inherit: Electron would boot as plain Node. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env
  return { ...inherited, ...extra }
}

/** Runs a program to completion; never throws, so a caller can assert on a refusal. */
export function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<Run> {
  return new Promise((done) => {
    const child = execFile(file, args, { cwd: opts.cwd, env: childEnv(), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null
      done({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export async function must(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  const r = await run(file, args, opts)
  if (r.code !== 0) throw new Error(`${file} ${args.join(' ')} failed (${String(r.code)}): ${(r.stderr || r.stdout).slice(-3000)}`)
  return r.stdout.trim()
}

export const IMAGE = 'slate-e2e-ubuntu'
export const REPO = resolve(__dirname, '../../..')
/** Gitignored and outside every lint, typecheck and test glob (`.tools/`). */
export const CACHE = join(REPO, '.tools', 'e2e-ubuntu')
/** v0.1.0's source, as `git archive` wrote it: the image's second build context. */
export const V010_SRC = join(CACHE, 'v0.1.0-src')
/** v0.1.0 installed and built on this Mac, once. */
export const V010_MAC = join(CACHE, 'v0.1.0-mac')
export const V010_MAC_MAIN = join(V010_MAC, 'packages', 'desktop', 'out', 'main', 'index.js')

/** Refuses before a build that could fill the disk (Docker's disk image grows on the same volume). */
export async function checkDisk(): Promise<void> {
  const macFree = process.platform === 'darwin' ? parseFreeBytesAsKb((await run('osascript', ['-l', 'JavaScript', '-e', MAC_FREE_BYTES_JXA])).stdout) : undefined
  const freeKb = macFree ?? parseDfFreeKb((await run('df', ['-k', homedir()])).stdout)
  const tooLow = freeKb === undefined ? undefined : lowDiskMessage(freeKb)
  if (tooLow !== undefined) throw new Error(tooLow)
}

async function v010Source(): Promise<void> {
  if (existsSync(join(V010_SRC, 'package.json'))) return
  mkdirSync(CACHE, { recursive: true })
  const tar = join(CACHE, 'v0.1.0.tar')
  await must('git', ['archive', '-o', tar, 'v0.1.0'], { cwd: REPO })
  mkdirSync(V010_SRC, { recursive: true })
  await must('tar', ['-xf', tar, '-C', V010_SRC])
  rmSync(tar, { force: true })
}

/** v0.1.0 for the Mac device: installed (its postinstall rebuilds better-sqlite3 for Electron) and built once. */
async function v010Mac(): Promise<void> {
  if (existsSync(V010_MAC_MAIN)) return
  rmSync(V010_MAC, { recursive: true, force: true })
  cpSync(V010_SRC, V010_MAC, { recursive: true })
  await must('npm', ['ci', '--no-audit', '--no-fund'], { cwd: V010_MAC, timeoutMs: 900_000 })
  await must('npm', ['run', '-w', '@slate/desktop', 'build'], { cwd: V010_MAC, timeoutMs: 300_000 })
}

/** The image, from this tree and v0.1.0's source; Docker's layer cache makes a rebuild after a source change quick. */
async function buildImage(): Promise<void> {
  const platform = process.env.SLATE_UBUNTU_PLATFORM // e.g. linux/amd64; unset builds the host's architecture
  await must(
    'docker',
    ['build', ...(platform ? ['--platform', platform] : []), '-t', IMAGE, '--build-context', `v010=${V010_SRC}`, '-f', 'packages/desktop/e2e-ubuntu/docker/Dockerfile', '.'],
    { cwd: REPO, timeoutMs: 3_600_000 },
  )
  // Only this bed's own dangling images: other projects' images on this machine are not ours to prune.
  await run('docker', ['image', 'prune', '-f', '--filter', 'label=slate.test-bed=e2e-ubuntu'])
}

/** Everything the scenarios need before the first app starts. */
export async function prepare(): Promise<void> {
  await must('docker', ['info'])
  await checkDisk()
  await v010Source()
  await v010Mac()
  await buildImage()
}

export interface Bed {
  name: string
  /** The host port that reaches the app's DevTools in the container. */
  port: number
  /** Host folder mounted at /remote in the container: the shared bare repositories live here. */
  shared: string
}

/** Starts the container with `shared` mounted at /remote and DevTools published on 127.0.0.1 only. */
export async function startBed(shared: string, port: number): Promise<Bed> {
  const name = `slate-xdev-${String(process.pid)}-${String(Date.now())}`
  await must('docker', ['run', '-d', '--init', '--name', name, '--label', 'slate.test-bed=e2e-ubuntu', '-p', `127.0.0.1:${String(port)}:9223`, '-v', `${shared}:/remote`, IMAGE])
  return { name, port, shared }
}

export async function stopBed(name: string): Promise<void> {
  await run('docker', ['rm', '-f', name])
}

/** Containers a killed run left behind. */
export async function removeStaleBeds(): Promise<void> {
  const ids = (await run('docker', ['ps', '-aq', '--filter', 'label=slate.test-bed=e2e-ubuntu'])).stdout.trim().split('\n').filter(Boolean)
  if (ids.length > 0) await run('docker', ['rm', '-f', ...ids])
}
