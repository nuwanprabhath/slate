/**
 * Which log files to delete, and when to start a new one.
 *
 * Both rules the user asked for apply at once and they can disagree: "keep a week" and "never
 * more than 20 MB" are different promises, and a busy week can break the second while satisfying
 * the first. The size budget wins, because it is the one that protects the machine — age only
 * decides *which* files go first.
 *
 * Pure, so the decisions are testable without a filesystem.
 */

export interface LogFile {
  name: string
  bytes: number
  modifiedMs: number
}

export interface PruneOptions {
  now: number
  retentionDays: number
  budgetBytes: number
  /** The file currently being written, which is never a candidate however big or old it is. */
  activeName: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The files to remove, oldest first.
 *
 * Age is applied before size so that "too old" files go even when the budget is comfortable, and
 * the remaining budget is then measured against everything left *including* the active file —
 * the promise is about how much disk the logs take, not how much the archived ones take.
 */
export function filesToPrune(files: LogFile[], opts: PruneOptions): string[] {
  const { now, retentionDays, budgetBytes, activeName } = opts
  const oldest = (a: LogFile, b: LogFile): number => a.modifiedMs - b.modifiedMs

  const archived = files.filter((f) => f.name !== activeName).sort(oldest)
  const doomed = new Set<string>()

  const cutoff = now - retentionDays * DAY_MS
  for (const file of archived) {
    if (file.modifiedMs < cutoff) doomed.add(file.name)
  }

  let total = files
    .filter((f) => !doomed.has(f.name))
    .reduce((sum, f) => sum + f.bytes, 0)
  for (const file of archived) {
    if (total <= budgetBytes) break
    if (doomed.has(file.name)) continue
    doomed.add(file.name)
    total -= file.bytes
  }

  return archived.filter((f) => doomed.has(f.name)).map((f) => f.name)
}

/**
 * Whether the active file should be rolled aside before writing `incomingBytes` more.
 *
 * A fifth of the budget, so a rotation leaves four older files' worth of history rather than one
 * enormous file and nothing else — and a floor of 1 MB, because a 1 MB budget rotating every
 * 200 KB produces files too short to contain a whole failure.
 */
export function shouldRotate(activeBytes: number, incomingBytes: number, budgetBytes: number): boolean {
  const cap = Math.max(1024 * 1024, Math.floor(budgetBytes / 5))
  return activeBytes > 0 && activeBytes + incomingBytes > cap
}
