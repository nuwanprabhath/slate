// Types for release-ci-gate.mjs, so the guard test imports it under strict TypeScript.
export interface CiRun { databaseId: number; status: string; conclusion: string | null }
export declare function ciVerdict(runs: readonly CiRun[], sha: string): string | null
