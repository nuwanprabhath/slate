#!/usr/bin/env node
// npm run new:channel -- <name> [--policy unlocked|pre-unlock|flush|send|event]
//
// Starts a new IPC channel the one supported way (docs/architecture/golden-paths.md#ipc): adds
// `<name>: '<group>:<kebab>'` to CH (src/shared/ipc.ts) and its rows to CHANNEL_POLICY and
// SELF_TEST_POLICY (src/main/ipcGuard.ts; refused while the power-up self-test runs or failed, C6). It writes nothing that passes on its own: tools/guards/ipcChannels.test.ts
// fails until main registers exactly one handler (or listener) for it, and the printed steps say
// where.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const POLICIES = ['unlocked', 'pre-unlock', 'flush', 'send', 'send-pre-unlock', 'event']

/** What to tell the agent about a policy that serves the channel while the vault is locked. */
export function policyWarning(policy) {
  if (!['pre-unlock', 'flush', 'send-pre-unlock'].includes(policy)) return null
  return `'${policy}' serves this channel while the vault is locked. That needs the maintainer: a reasoned line in tools/guards/allowlists/ipc-ungated.json, which the ratchet refuses from an agent branch. Use 'unlocked' (or 'send') unless the lock screen cannot work without it.`
}

/** `syncNow` → `sync:now`; `vaultQuickUnlockInfo` → `vault:quick-unlock-info`. */
export function channelValue(name) {
  const [group, ...rest] = name.split(/(?=[A-Z])/)
  return `${group}:${rest.map((w) => w.toLowerCase()).join('-')}`
}

/** The two edits, as pure text transforms so they are testable. */
export function addChannel({ ipcTs, guardTs }, name, policy) {
  if (!/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`"${name}" must be camelCase with a group prefix, e.g. syncNow or themesList`)
  if (!POLICIES.includes(policy)) throw new Error(`policy must be one of ${POLICIES.join(', ')}`)
  if (new RegExp(`^\\s+${name}:`, 'm').test(ipcTs)) throw new Error(`CH.${name} already exists`)
  const chEnd = ipcTs.lastIndexOf('} as const')
  const policyEnd = guardTs.indexOf('\n}', guardTs.indexOf('export const CHANNEL_POLICY'))
  const selfTestEnd = guardTs.indexOf('\n}', guardTs.indexOf('export const SELF_TEST_POLICY'))
  if (chEnd < 0 || policyEnd < 0 || selfTestEnd < 0) throw new Error('could not find CH, CHANNEL_POLICY or SELF_TEST_POLICY; add the entries by hand (golden-paths.md#ipc)')
  // A new channel is never served after a failed self-test: that set is the error screen's, pinned by the guards.
  const selfTest = policy === 'event' ? 'event' : 'refused'
  const [first, second] = policyEnd < selfTestEnd ? [policyEnd, selfTestEnd] : [selfTestEnd, policyEnd]
  const rowAt = (at) => (at === policyEnd ? `\n  ${name}: '${policy}',` : `\n  ${name}: '${selfTest}',`)
  return {
    ipcTs: `${ipcTs.slice(0, chEnd)}  ${name}: '${channelValue(name)}',\n${ipcTs.slice(chEnd)}`,
    guardTs: `${guardTs.slice(0, first)}${rowAt(first)}${guardTs.slice(first, second)}${rowAt(second)}${guardTs.slice(second)}`,
  }
}

function main() {
  const args = process.argv.slice(2)
  const name = args.find((a) => !a.startsWith('--'))
  const policy = args.includes('--policy') ? args[args.indexOf('--policy') + 1] : 'unlocked'
  if (!name) {
    process.stderr.write('usage: npm run new:channel -- <camelCaseName> [--policy unlocked|pre-unlock|flush|send|event]\n')
    process.exit(64)
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const ipcPath = join(root, 'packages/desktop/src/shared/ipc.ts')
  const guardPath = join(root, 'packages/desktop/src/main/ipcGuard.ts')
  const out = addChannel({ ipcTs: readFileSync(ipcPath, 'utf8'), guardTs: readFileSync(guardPath, 'utf8') }, name, policy)
  writeFileSync(ipcPath, out.ipcTs)
  writeFileSync(guardPath, out.guardTs)
  const register = policy === 'send' ? `ipc.on(CH.${name}, (_e, …) => …)` : policy === 'event' ? `webContents.send(CH.${name}, payload) from main` : `ipc.handle(CH.${name}, (_e, …) => …)`
  const warning = policyWarning(policy)
  if (warning) process.stderr.write(`WARNING: ${warning}\n`)
  process.stdout.write(
    [
      `Added CH.${name} = '${channelValue(name)}' (${policy}). Now, in order:`,
      `  1. src/shared/api.ts: the method on SlateApi.`,
      `  2. src/preload/index.ts: ipcRenderer.${policy === 'send' ? 'send' : policy === 'event' ? 'on' : 'invoke'}(CH.${name}, …).`,
      `  3. Main: ${register}, inside a register…Ipc(ipc, …) called from index.ts; validate every argument.`,
      `  4. A test of the handler; npm run guards checks the registration.`,
      '',
    ].join('\n'),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
