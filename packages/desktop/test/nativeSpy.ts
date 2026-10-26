// Counts every call a main-process test makes into @slate/native (C5 criterion 2: "a spy on the native object
// counts zero calls"). The addon's methods are read-only, so each is shadowed on an object that inherits the
// rest (the SQLCipher binding included). Register it before the first database or key is touched:
//   const calls = spyOnNative()
import type { SlateNative } from '@slate/native'
import { provideDbModule } from '../src/main/db/dbModule'
import { startTestDbModule } from '../src/main/db/testModule'

export type NativeCalls = Map<string, number>

export function counting(n: SlateNative, calls: NativeCalls): SlateNative {
  const wrapped = Object.create(n) as SlateNative
  // N-API defines the methods non-enumerable: own property names, not Object.keys.
  for (const name of Object.getOwnPropertyNames(n) as (keyof SlateNative)[]) {
    const value = n[name]
    if (typeof value !== 'function') continue
    Object.defineProperty(wrapped, name, {
      value: (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1)
        return (value as (...a: unknown[]) => unknown).apply(n, args)
      },
    })
  }
  return wrapped
}

/** Makes this test file's module a counting one; the returned map fills as the code under test calls in. */
export function spyOnNative(): NativeCalls {
  const calls: NativeCalls = new Map()
  provideDbModule(() => {
    const m = startTestDbModule()
    return { ...m, native: counting(m.native, calls) }
  })
  return calls
}
