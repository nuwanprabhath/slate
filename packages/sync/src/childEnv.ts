/**
 * Variables that tell git which repository, index, objects or config to use instead of the working
 * directory's (`git rev-parse --local-env-vars`, plus the numbered config pairs and the namespace).
 * A Slate (or a test) started under a git hook or `git rebase --exec` inherits them, and every sync
 * command would then act on that repository: under a pre-push hook it once set `core.bare=true` on
 * the repository being pushed. Sync chooses its repository by `cwd`, and its own config pairs
 * (tokenEnv) are added after this.
 */
const REPOSITORY_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
const CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/

/**
 * The environment a git child process inherits: this process's, so git finds PATH, HOME and its
 * credential helpers, less the variables that would point it at another repository. The one place
 * in packages/sync that touches process.env (lint rule `slate/env-through-test-hooks`); nothing
 * here reads a variable by name, so a test hook scrubbed at startup in main (src/main/testHooks.ts)
 * is already gone from it.
 */
export function inheritedEnv(): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !REPOSITORY_VARIABLES.has(name) && !CONFIG_PAIR.test(name)))
}
