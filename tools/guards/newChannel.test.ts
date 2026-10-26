import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript with no declaration file; the calls below pin its shape
import { addChannel, channelValue, policyWarning } from '../../scripts/new-channel.mjs'
import { read } from './repo'

const files = () => ({ ipcTs: read('packages/desktop/src/shared/ipc.ts'), guardTs: read('packages/desktop/src/main/ipcGuard.ts') })

describe('npm run new:channel', () => {
  it('derives the wire name from the camelCase name', () => {
    expect(channelValue('syncNow')).toBe('sync:now')
    expect(channelValue('vaultQuickUnlockInfo')).toBe('vault:quick-unlock-info')
  })

  it('adds the CH entry and its CHANNEL_POLICY and SELF_TEST_POLICY rows to the real files', () => {
    const out = addChannel(files(), 'notesArchive', 'unlocked') as { ipcTs: string; guardTs: string }
    expect(out.ipcTs).toMatch(/\n {2}notesArchive: 'notes:archive',\n\} as const/)
    expect(out.guardTs).toMatch(/\n {2}notesArchive: 'unlocked',\n\}/)
    // C6: refused while the power-up self-test runs or after it failed; an event is never served anyway.
    expect(out.guardTs).toMatch(/\n {2}notesArchive: 'refused',\n\}/)
    expect((addChannel(files(), 'notesArchived', 'event') as { guardTs: string }).guardTs).toMatch(/\n {2}notesArchived: 'event',\n\}[\s\S]*\n {2}notesArchived: 'event',\n\}/)
    // Nothing else moved: ipc.ts grew by one line, ipcGuard.ts by one row in each table.
    expect(out.ipcTs.split('\n').length).toBe(files().ipcTs.split('\n').length + 1)
    expect(out.guardTs.split('\n').length).toBe(files().guardTs.split('\n').length + 2)
  })

  it('warns that a channel served while locked needs the maintainer (red team 2a)', () => {
    for (const p of ['pre-unlock', 'flush', 'send-pre-unlock']) expect(policyWarning(p), p).toMatch(/needs the maintainer/)
    for (const p of ['unlocked', 'send', 'event']) expect(policyWarning(p), p).toBeNull()
  })

  it('refuses a duplicate, a bad name and an unknown policy', () => {
    expect(() => addChannel(files(), 'docsList', 'unlocked')).toThrow(/already exists/)
    expect(() => addChannel(files(), 'archive', 'unlocked')).toThrow(/camelCase/)
    expect(() => addChannel(files(), 'notesArchive', 'open')).toThrow(/policy/)
  })
})
