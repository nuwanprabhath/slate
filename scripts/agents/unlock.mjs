#!/usr/bin/env node
// The lead's tool for guardrail unlocks, run by the maintainer by hand (guard-edits refuses it to
// agents). An unlock line is `<branch> <token> <signature>`: the token is the branch's absolute
// worktree path or its first commit since main, and the signature is Ed25519 over
// UNLOCK_MESSAGE(branch, token) with the lead's private key, which lives OUTSIDE the repository:
//
// - macOS: only the login Keychain, item `slate-guardrails` / account `lead`, created with an empty
//   trusted-application list (`-T ""`), so every read asks the person at the screen. There is no file
//   fallback on macOS: a key file would be readable by any process the user runs (red team G2-10).
// - Linux: ~/.config/slate-release/guardrails.key, encrypted with a passphrase, used only with an
//   explicit --file from an interactive terminal; the passphrase is typed each time.
//
// guard-edits.mjs and merge-wp verify a line against the public key in tools/guards/unlock-key.pub, so
// a line written by anyone without the private key unlocks nothing.
//
//   node scripts/agents/unlock.mjs --init [--file]     make the key pair; refuses if one exists
//   node scripts/agents/unlock.mjs --rotate [--file]   replace the key pair; prints the new public key
//   node scripts/agents/unlock.mjs <branch> <token> [--file]   sign and append the unlock line
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ReadStream, WriteStream } from 'node:tty'
import { fileURLToPath } from 'node:url'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { UNLOCK_MESSAGE } from './review-gate.mjs'

export const KEYCHAIN_SERVICE = 'slate-guardrails'
export const KEYCHAIN_ACCOUNT = 'lead'
export const KEY_FILE = join(homedir(), '.config', 'slate-release', 'guardrails.key')

/** `<branch> <token> <base64 signature>` signed with the lead's private key (PEM or KeyObject). */
export function signUnlockLine(privateKey, branch, token) {
  if (/\s/.test(branch) || /\s/.test(token)) throw new Error('branch and token may not contain spaces')
  const signature = sign(null, Buffer.from(UNLOCK_MESSAGE(branch, token), 'utf8'), privateKey).toString('base64')
  return `${branch} ${token} ${signature}`
}

/**
 * The `security` invocation that stores the key: `security -i` reads its command from stdin, so the
 * private key never appears in any process's argument list (red team G2-11). `-U` (replace) only for
 * --rotate; `-T ""` trusts no application, so every read asks the person.
 */
export function keychainAddCommand(pemBase64, { rotate }) {
  const update = rotate ? ' -U' : ''
  return { args: ['-i'], input: `add-generic-password${update} -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -T "" -w ${pemBase64}\n` }
}

/**
 * The private key as a KeyObject. macOS: the Keychain only (its dialog is the human step). Elsewhere:
 * the passphrase-protected file, only with --file and a terminal. Never a silent fallback.
 * Dependencies are injected so tools/guards/leadTools.test.ts can run it.
 */
export async function loadSigningKey({ platform, useFile, isTTY, keychainRead, readFile, askPassphrase }) {
  if (platform === 'darwin') {
    if (useFile) throw new Error('on macOS the lead key lives only in the Keychain; --file is for Linux')
    let b64
    try {
      b64 = keychainRead()
    } catch (e) {
      throw new Error(`the Keychain did not release the lead key (item ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}): ${e instanceof Error ? e.message.split('\n')[0] : e}. Allow it in the dialog, or run --init once.`)
    }
    return createPrivateKey(Buffer.from(String(b64).trim(), 'base64').toString('utf8'))
  }
  if (!useFile) throw new Error(`outside macOS the lead key is the passphrase-protected ${KEY_FILE}; pass --file to use it`)
  if (!isTTY) throw new Error('the lead key needs an interactive terminal for its passphrase')
  const pem = readFile()
  if (!pem) throw new Error(`no ${KEY_FILE}: run --init --file first`)
  return createPrivateKey({ key: pem, format: 'pem', passphrase: await askPassphrase('Passphrase for the lead key: ') })
}

/** Makes the key pair and stores the private half; returns the public key PEM. Refuses to replace one unless rotating. */
export async function initKey({ platform, rotate, useFile, isTTY, exists, storeKeychain, writeFile, askPassphrase }) {
  if (exists() && !rotate) throw new Error('a lead key already exists; --rotate replaces it (and every unlock line and confirmation it signed stops counting)')
  if (platform !== 'darwin' && (!useFile || !isTTY)) throw new Error('outside macOS, --init needs --file and an interactive terminal for the passphrase')
  if (platform === 'darwin' && useFile) throw new Error('on macOS the lead key lives only in the Keychain; --file is for Linux')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  if (platform === 'darwin') {
    storeKeychain(keychainAddCommand(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64'), { rotate }).input)
  } else {
    const passphrase = await askPassphrase('New passphrase for the lead key: ')
    if (passphrase.length < 12 || passphrase !== (await askPassphrase('Again: '))) throw new Error('the passphrases differ or are shorter than 12 characters')
    writeFile(privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString())
  }
  return publicKey.export({ type: 'spki', format: 'pem' }).toString()
}

/** One line typed at the controlling terminal with echo off. Throws a plain "no terminal" without one. */
export async function askHidden(question) {
  let fd
  try {
    fd = openSync('/dev/tty', 'r+')
  } catch {
    throw new Error('no terminal: run this yourself, in a terminal')
  }
  // A tty.ReadStream goes raw under readline, so the only echo is readline's, which is muted below.
  const input = new ReadStream(fd)
  const output = new WriteStream(fd)
  const rl = createInterface({ input, output, terminal: true })
  let muted = false
  rl._writeToOutput = (s) => {
    if (!muted) output.write(s)
  }
  try {
    const answer = rl.question(question)
    muted = true
    return await answer
  } finally {
    output.write('\n')
    rl.close()
    input.destroy()
  }
}

/** The real dependencies: the `security` CLI, the key file and the terminal. */
export function systemDeps(args) {
  const keychainArgs = ['-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]
  return {
    platform: process.platform,
    useFile: args.includes('--file'),
    rotate: args.includes('--rotate'),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) && existsSync('/dev/tty'),
    keychainRead: () => execFileSync('security', ['find-generic-password', ...keychainArgs, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    readFile: () => (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : null),
    exists: () => {
      if (process.platform !== 'darwin') return existsSync(KEY_FILE)
      try {
        // Without -w this reads the item's attributes only: no secret, no dialog.
        execFileSync('security', ['find-generic-password', ...keychainArgs], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    storeKeychain: (input) => execFileSync('security', ['-i'], { input, stdio: ['pipe', 'inherit', 'inherit'] }),
    writeFile: (pem) => {
      mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
      writeFileSync(KEY_FILE, pem, { mode: 0o600 })
      chmodSync(KEY_FILE, 0o600)
    },
    askPassphrase: askHidden,
  }
}

/** Signs `message` with the lead key (merge-wp's confirmations). Asks the person, through the Keychain or a passphrase. */
export async function signWithLeadKey(message, args = []) {
  const key = await loadSigningKey(systemDeps(args))
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64')
}

async function main() {
  const args = process.argv.slice(2)
  const deps = systemDeps(args)
  if (args[0] === '--init' || args[0] === '--rotate') {
    const pub = await initKey({ ...deps, rotate: args[0] === '--rotate' })
    process.stdout.write(`${process.platform === 'darwin' ? `Private key stored in the login Keychain (${KEYCHAIN_SERVICE} / ${KEYCHAIN_ACCOUNT}); every read asks you.` : `Private key written to ${KEY_FILE} (mode 600, passphrase-protected).`}\n`)
    process.stdout.write(`Commit this public key as tools/guards/unlock-key.pub, by hand${args[0] === '--rotate' ? ' (it replaces the old one: earlier unlock lines and confirmations stop counting)' : ''}:\n\n${pub}`)
    return
  }
  const [branch, token] = args.filter((a) => !a.startsWith('--'))
  if (!branch || !token) {
    process.stderr.write('usage: node scripts/agents/unlock.mjs <branch> <absolute worktree path | first commit sha> [--file]\n       node scripts/agents/unlock.mjs --init|--rotate [--file]\n')
    process.exit(64)
  }
  const commonDir = resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
  const line = signUnlockLine(await loadSigningKey(deps), branch, token)
  appendFileSync(join(commonDir, 'slate-guardrails-unlock'), `${line}\n`)
  process.stdout.write(`Unlocked ${branch} for ${token}.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`unlock: ${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
  })
}
