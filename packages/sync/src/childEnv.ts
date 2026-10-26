/**
 * The environment a git child process inherits: the whole of this process's, so git finds PATH,
 * HOME and its credential helpers. The one place in packages/sync that touches process.env (lint
 * rule `slate/env-through-test-hooks`); nothing here reads a variable by name, so a test hook
 * scrubbed at startup in main (src/main/testHooks.ts) is already gone from it.
 */
export function inheritedEnv(): Readonly<Record<string, string | undefined>> {
  return { ...process.env }
}
