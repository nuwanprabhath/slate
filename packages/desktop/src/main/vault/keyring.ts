// The only owner of the unlocked vault's keys (§3 of the spec; audit B.13, rules Z-1 to Z-4). The keys
// live in @slate/native's secure heap; this class holds handles, and JavaScript never sees a key byte.
import type { KeyHandle } from '@slate/native'
import { vaultNative } from './native'
import { SUITE, vidOf, type KeySchedule } from './suite'
import { v1Subkey } from './suite1'

export class Locked extends Error {
  override name = 'Locked'
  constructor() {
    super('Slate is locked')
  }
}

/** Suite 0x01 (header v1): RFC 5869 HKDF-SHA-256 info strings. */
const V1_INFO = {
  sync: 'slate/v1/sync',
  name: 'slate/v1/name',
  nameEnc: 'slate/v1/name-enc',
  check: 'slate/v1/check',
  prefs: 'slate/v1/prefs',
  localwrap: 'slate/v1/local-wrap',
} as const

/** Suite 0x02 (header v2): SP 800-108r1 KBKDF labels, `"slate/v2/" + x` (audit §4.5.2); the Context is `vid`. */
const V2_LABEL = {
  sync: 'slate/v2/sync',
  name: 'slate/v2/name',
  nameEnc: 'slate/v2/name-enc',
  nameMac: 'slate/v2/name-mac',
  check: 'slate/v2/check',
  prefs: 'slate/v2/prefs',
  localwrap: 'slate/v2/local-wrap',
} as const

export type SubkeyName = keyof typeof V2_LABEL
export type KeyName = 'mk' | 'lk' | SubkeyName

/** The subkeys a schedule has: suite 0x01 has no name MAC key (its names are one AES block). */
export function subkeysOf(schedule: KeySchedule): SubkeyName[] {
  return schedule.suite === SUITE.HKDF_AES256GCM ? (Object.keys(V1_INFO) as SubkeyName[]) : (Object.keys(V2_LABEL) as SubkeyName[])
}

/**
 * The caller owns the returned subkey and destroys it once used (or hands it to a KeyRing). K_localwrap is
 * a KEK: it wraps and unwraps this device's LK and does nothing else (review C4 M1).
 */
export function deriveSubkey(mk: KeyHandle, name: SubkeyName, schedule: KeySchedule): KeyHandle {
  const usage = name === 'localwrap' ? 'kek' : 'data'
  if (schedule.suite === SUITE.KBKDF_AES256GCM) return vaultNative().kbkdf(mk, V2_LABEL[name], vidOf(schedule.vaultId), usage)
  if (name === 'nameMac') throw new Error('Suite 0x01 has no name MAC key')
  return v1Subkey(mk, V1_INFO[name], usage)
}

/** C9: an earlier key epoch the ring can read (header `history`): its MK, its schedule, the subkeys made so far. */
interface EpochRing {
  readonly schedule: KeySchedule
  readonly mk: KeyHandle
  readonly subkeys: Map<SubkeyName, KeyHandle>
}

/** The read-only keys of an earlier epoch: files sealed then open, nothing is written under them. */
export interface EpochKeys {
  readonly schedule: KeySchedule
  get(name: 'sync' | 'name' | 'nameEnc' | 'nameMac'): KeyHandle
}

export class KeyRing {
  private handles: Map<KeyName, KeyHandle> | null = new Map()
  private readonly epochs = new Map<number, EpochRing>()

  /**
   * Takes ownership of `mk` and `lk`: from here the ring destroys them, at `close`, and the caller
   * must not. If a subkey cannot be derived, every handle taken or made so far is destroyed.
   */
  constructor(mk: KeyHandle, lk: KeyHandle | undefined, readonly schedule: KeySchedule) {
    const map = this.handles!
    map.set('mk', mk)
    if (lk !== undefined) map.set('lk', lk)
    try {
      for (const name of subkeysOf(schedule)) map.set(name, deriveSubkey(mk, name, schedule))
    } catch (e) {
      this.close()
      throw e
    }
  }

  get isOpen(): boolean {
    return this.handles !== null
  }

  /** Valid until `close`; using it afterwards throws SCC_8 in the module and never yields zeros. Never destroy it. */
  get(name: KeyName): KeyHandle {
    if (!this.handles) throw new Locked()
    const h = this.handles.get(name)
    if (h === undefined) throw new Error(`No ${name} key in this key ring`)
    return h
  }

  /**
   * C9: takes ownership of the master keys of earlier epochs (`openHistory`), so their files stay readable until
   * the rotating device has replaced them (audit §4.7 R-2). Their subkeys are derived when first asked for.
   */
  attachHistory(keys: ReadonlyMap<number, { mk: KeyHandle; schedule: KeySchedule }>): void {
    for (const [epoch, k] of keys) {
      if (!this.handles || this.epochs.has(epoch)) {
        vaultNative().keyDestroy(k.mk)
        continue
      }
      this.epochs.set(epoch, { schedule: k.schedule, mk: k.mk, subkeys: new Map() })
    }
  }

  /** The earlier epochs this ring reads, newest first. */
  get historyEpochs(): number[] {
    return [...this.epochs.keys()].sort((a, b) => b - a)
  }

  /** An earlier epoch's keys, or null when the ring does not hold it. Valid until `close`. */
  epochKeys(epoch: number): EpochKeys | null {
    if (!this.handles) throw new Locked()
    const e = this.epochs.get(epoch)
    if (!e) return null
    return {
      schedule: e.schedule,
      get: (name) => {
        if (!this.handles) throw new Locked()
        let h = e.subkeys.get(name)
        if (h === undefined) {
          h = deriveSubkey(e.mk, name, e.schedule)
          e.subkeys.set(name, h)
        }
        return h
      },
    }
  }

  /**
   * Closes first, so no accessor can hand out a handle being destroyed, then destroys every handle and
   * checks with the module that none survived (Z-4, the ISO/IEC 19790 AS09.33 completion indicator).
   * Returns how many were destroyed; throws if the module still counts any of them as live.
   */
  close(): number {
    const handles = this.handles
    this.handles = null
    if (!handles) return 0
    const n = vaultNative()
    const before = n.status().liveHandles
    let destroyed = 0
    const all = [...handles.values()]
    for (const e of this.epochs.values()) all.push(e.mk, ...e.subkeys.values())
    this.epochs.clear()
    for (const h of all) {
      try {
        n.keyDestroy(h)
        destroyed++
      } catch {
        // Already destroyed (zeroizeAll in the error path): not live either way.
      }
    }
    if (n.status().liveHandles > before - destroyed) throw new Error('Key ring close left live key handles')
    return destroyed
  }
}
