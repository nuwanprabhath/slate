/**
 * Loro frees nothing of a document while a handle read from it is alive: a container (`LoroMap`, `LoroList`,
 * `LoroText`, `LoroTree`), a tree node, or a fork. A handle nobody freed goes only when Loro's FinalizationRegistry
 * runs, in a task of its own, so code that reads handles and never awaits keeps every document it opened, whatever
 * it calls `free()` on: 214 kB a page for `agentBoxes`, 47 kB a notebook for a tree walk (FX-30, FX-33, FX-35).
 *
 * So core reads Loro inside a scope, and passes whatever Loro returns through `own`, which frees it when the scope
 * ends. `test/handleLifetime.test.ts` holds every file in core to that.
 */
export interface Handles {
  /**
   * Takes what Loro just returned, a value or an array of them, and returns it unchanged; every handle in it is
   * freed when the scope ends. Wrap the read itself, also one expected to return a number or a string: a peer can
   * put a container under any key. Own a handle once, where it was read.
   */
  own<T>(value: T): T
  /**
   * Lets an owned handle outlive a scope that returns, for the few places whose caller needs the handle itself.
   * The caller then frees it. A scope that throws frees it all the same.
   */
  keep<T>(value: T): T
}

interface Freeable {
  free(): void
}

// Not `instanceof`: every class Loro exports with a `free` holds memory the same way, also ones added later.
function isFreeable(value: unknown): value is Freeable {
  return typeof value === 'object' && value !== null && typeof (value as { free?: unknown }).free === 'function'
}

/**
 * Runs `fn` and frees every handle it owned, whether it returns or throws. `fn` is synchronous: a scope that ended
 * at the first `await` would free handles the rest of the function still uses.
 */
export function withHandles<T>(fn: (h: Handles) => T): T {
  const owned = new Set<Freeable>()
  const kept = new Set<Freeable>()
  let open = true
  const h: Handles = {
    own(value) {
      if (!open) throw new Error('A handle scope was used after it ended')
      if (Array.isArray(value)) {
        for (const item of value) if (isFreeable(item)) owned.add(item)
      } else if (isFreeable(value)) owned.add(value)
      return value
    },
    keep(value) {
      if (isFreeable(value)) kept.add(value)
      return value
    },
  }
  let returned = false
  try {
    const result = fn(h)
    if (isThenable(result)) throw new Error('A handle scope cannot be async: its handles are freed when the function returns')
    returned = true
    return result
  } finally {
    open = false
    // Last read first, so a fork goes after the containers read from it.
    for (const handle of [...owned].reverse()) if (!(returned && kept.has(handle))) handle.free()
  }
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}
