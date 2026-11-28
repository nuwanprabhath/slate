// Types for quality-cadence.mjs, so the guard test imports it under strict TypeScript.
export interface Every { lines: number; days: number }
export interface Run { conclusion: string | null; createdAt: string; number: number }
export declare const LEDGER: string
export declare const MIN_LINES_FOR_DAYS: number
export declare function changeReason(name: string, every: Every, linesSince: number, daysSince: number): string | null
export declare function matchPaths(changed: readonly string[], globs: readonly string[]): string[]
export declare function pathReason(name: string, matched: readonly string[]): string | null
export declare function nightlyReason(name: string, runs: readonly Run[], sinceIso: string): string | null
export declare function dueMessage(reasons: readonly string[]): string
export declare function owedAt(ledger: unknown, sha: string, options?: { now?: number; offline?: boolean }): string[]
