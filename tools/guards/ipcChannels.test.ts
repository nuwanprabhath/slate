import { describe, expect, it } from 'vitest'
import { CH } from '../../packages/desktop/src/shared/ipc'
import { allowlist, isTestFile, read, walk } from './repo'

/**
 * Every IPC channel goes through the one door: classified in CHANNEL_POLICY (src/main/ipcGuard.ts),
 * registered through the registrar `createIpc` returns, as often as its kind says. ipcGuard.ts is
 * read as text so this runs without Electron.
 */
type Policy = 'pre-unlock' | 'flush' | 'unlocked' | 'send' | 'send-pre-unlock' | 'event'
const isSend = (k: Policy) => k === 'send' || k === 'send-pre-unlock'

function channelPolicy(): Map<string, Policy> {
  const text = read('packages/desktop/src/main/ipcGuard.ts')
  const block = /export const CHANNEL_POLICY[^=]*= \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  const policy = new Map<string, Policy>()
  for (const m of block.matchAll(/^\s+(\w+): '(pre-unlock|flush|unlocked|send-pre-unlock|send|event)',$/gm)) policy.set(m[1]!, m[2] as Policy)
  return policy
}

const MAIN = walk('packages/desktop/src/main', ['.ts'], isTestFile).filter((f) => !isTestFile(f))
const sources = MAIN.map((f) => ({ file: f, text: read(f) }))

function sites(pattern: (name: string) => RegExp, name: string): string[] {
  return sources.flatMap(({ file, text }) => Array.from(text.matchAll(pattern(name)), () => file))
}

describe('IPC channels', () => {
  const policy = channelPolicy()

  it('CHANNEL_POLICY classifies every CH channel, and nothing else', () => {
    expect(policy.size, 'CHANNEL_POLICY could not be read from src/main/ipcGuard.ts').toBeGreaterThan(0)
    expect([...policy.keys()].sort()).toEqual(Object.keys(CH).sort())
  })

  it('every channel reachable while locked is pinned in allowlists/ipc-ungated.json (red team 2a/2b)', () => {
    const pinned = new Set(Object.keys(allowlist('ipc-ungated')))
    const ungated = [...policy].filter(([, kind]) => kind !== 'unlocked' && kind !== 'event' && kind !== 'send').map(([name, kind]) => `${kind}:${name}`)
    const unpinned = ungated.filter((k) => !pinned.has(k))
    const stale = [...pinned].filter((k) => !ungated.includes(k))
    expect(
      unpinned.map((k) => `${k} runs while the vault is locked. That needs the maintainer's approval: a line in tools/guards/allowlists/ipc-ungated.json with the reason, which the ratchet refuses from an agent branch. Use 'unlocked' (or 'send') unless the lock screen cannot work without it.`),
    ).toEqual([])
    expect(stale.map((k) => `${k} in ipc-ungated.json no longer matches CHANNEL_POLICY: delete the line`)).toEqual([])
  })

  it('each invoke channel has exactly one handler, registered through the registrar', () => {
    const problems: string[] = []
    for (const [name, kind] of policy) {
      if (isSend(kind) || kind === 'event') continue
      const found = sites((n) => new RegExp(`\\bipc\\.handle\\(\\s*CH\\.${n}\\b`, 'g'), name)
      if (found.length !== 1) {
        problems.push(`CH.${name} (${kind}) has ${String(found.length)} \`ipc.handle(CH.${name}, …)\`${found.length ? ` in ${found.join(', ')}` : ''}; it needs exactly one, in a register…Ipc(ipc, …) function called from index.ts`)
      }
    }
    expect(problems).toEqual([])
  })

  it('each send channel is listened to through the registrar, and no event channel is registered', () => {
    const problems: string[] = []
    for (const [name, kind] of policy) {
      const on = sites((n) => new RegExp(`\\bipc\\.on\\(\\s*CH\\.${n}\\b`, 'g'), name)
      const handled = sites((n) => new RegExp(`\\bipc\\.handle\\(\\s*CH\\.${n}\\b`, 'g'), name)
      if (isSend(kind) && on.length === 0) problems.push(`CH.${name} is a send channel but nothing calls \`ipc.on(CH.${name}, …)\`; listen in main, or drop the channel`)
      if (!isSend(kind) && on.length > 0) problems.push(`CH.${name} is ${kind} but ${on.join(', ')} listens with ipc.on; mark it 'send' in CHANNEL_POLICY only if it is harmless while locked`)
      if (kind === 'event' && handled.length > 0) problems.push(`CH.${name} is an event (main → renderer) but ${handled.join(', ')} registers a handler`)
    }
    expect(problems).toEqual([])
  })

  it('each event channel is sent from main', () => {
    const problems: string[] = []
    for (const [name, kind] of policy) {
      if (kind !== 'event') continue
      const sent = sites((n) => new RegExp(`\\b(?:send|emit|toWindows)\\(\\s*CH\\.${n}\\b`, 'g'), name)
      if (sent.length === 0) problems.push(`CH.${name} is an event channel but main never sends it (webContents.send / emit / toWindows); drop it from CH or send it`)
    }
    expect(problems).toEqual([])
  })

  it('nothing in main touches ipcMain except the registrar', () => {
    const offenders = sources.filter(({ file, text }) => file !== 'packages/desktop/src/main/ipcGuard.ts' && /\bipcMain\b/.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    expect(offenders.map((o) => o.file)).toEqual([])
  })
})
