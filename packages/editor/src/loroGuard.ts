import { LoroMap, isContainer, type LoroDoc } from 'loro-crdt'

/**
 * loro-prosemirror (0.4.4) deletes every null-valued node attribute on each update, whether or not
 * the key is stored, and Loro records each delete as an op: with null-default attributes (textAlign,
 * indent, checked, image width) every keystroke added two or more ops to the page's history for good.
 * Deleting a key this peer cannot see has no effect it could intend, and could only remove another
 * peer's concurrent value, so it is skipped.
 *
 * The skip belongs to this binding, not to the library: patching `LoroMap.prototype` would change
 * what the same document code does in the renderer but not in main, sync or MCP. Instead the doc
 * handed to `LoroSyncPlugin` is wrapped, and every container reached through it is wrapped too, so
 * the guard covers exactly the containers that plugin touches.
 */
export function guardedDoc(doc: LoroDoc): LoroDoc {
  return wrap(doc)
}

const wrappers = new WeakMap<object, object>()

type AnyFn = (...args: unknown[]) => unknown

function wrapValue(value: unknown): unknown {
  if (isContainer(value)) return wrap(value as unknown as object)
  if (Array.isArray(value)) return value.some(isContainer) ? value.map(wrapValue) : value
  return value
}

function wrap<T extends object>(target: T): T {
  const cached = wrappers.get(target)
  if (cached) return cached as T
  const members = new Map<string | symbol, unknown>()
  const isMap = target instanceof LoroMap
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (members.has(prop)) return members.get(prop)
      const value = Reflect.get(t, prop, t) as unknown
      if (typeof value !== 'function') return wrapValue(value)
      const fn: AnyFn =
        isMap && prop === 'delete'
          ? (key: unknown) => {
              // A key this peer cannot see: deleting it can only remove a concurrent remote value.
              if ((t as unknown as LoroMap).get(key as string) === undefined) return undefined
              return (value as AnyFn).call(t, key)
            }
          : (...args: unknown[]) => wrapValue((value as AnyFn).apply(t, args))
      members.set(prop, fn)
      return fn
    },
  })
  wrappers.set(target, proxy)
  return proxy as T
}
