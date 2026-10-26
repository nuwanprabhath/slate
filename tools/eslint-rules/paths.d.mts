// Types for paths.mjs, which the guard tests import.
export declare const ROOT: string
export declare function repoPath(filename: string): string
export declare function globToRegExp(glob: string): RegExp
export declare function matchesAny(file: string, globs: readonly string[] | undefined): boolean
export declare function resolveImport(file: string, source: string): string | null
export declare function allowlist(name: string): Record<string, string | { names: string[]; reason: string }>
export declare function allowlistNames(): string[]
