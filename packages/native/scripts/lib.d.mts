export declare const PACKAGE_DIR: string
export declare const BUILD_DIR: string
export declare const TARGETS: string[]
export declare function configureTarget(target: string): string
export declare function hostTarget(platform?: string, arch?: string): string
export declare function fipsModuleFile(target: string): 'fips.dylib' | 'fips.so'
export declare class DigestMismatch extends Error {
  constructor(file: string, expected: string, actual: string)
}
export declare function sha256File(file: string): string
export declare function verifyTarball(file: string, expected: string): string
export declare function parsePublishedSha256(text: string): string
export declare const REQUIRED_EXPORTS: ReadonlySet<string>
export declare function exportedSymbols(nmOutput: string, platform: string): string[]
export declare function checkExports(symbols: string[]): { ok: boolean; extra: string[]; missing: string[] }
export declare function opensslPrefix(target: string): string
export declare function fipsOutDir(target: string): string
export declare function prebuildPath(target: string): string
export declare const FORBIDDEN_STRINGS: readonly string[]
export declare function forbiddenStrings(binary: Uint8Array): string[]
export interface FipsPin {
  provider: string
  config: string
}
export declare function checkPin(target: string, actual: FipsPin, pins: Record<string, FipsPin>, update: boolean): Record<string, FipsPin>
export declare function pinHeader(pin: FipsPin | undefined): string
export declare function writePinHeader(target: string): string
export declare const MACOS_MIN: string
export declare function buildEnv(env: Record<string, string | undefined>, target: string): Record<string, string>
export declare function sqlcipherDir(): string
export declare function patchSqlcipher(source: string): string
export declare function patchOpensslArgon2(source: string): string
export declare function buildKind(binary: Uint8Array): 'release' | 'kat' | null
