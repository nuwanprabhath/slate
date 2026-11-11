// Types for scripts/traceability.mjs (imported by tools/guards/traceability.test.ts).
export interface Entry {
  wp: string[]
  tests: string[]
  lab?: string[]
  poam?: boolean | string
}
export interface MatrixEntry extends Omit<Entry, 'tests'> {
  id: string
  tests: [string, string[]][]
}
export interface Matrix {
  findings: MatrixEntry[]
  rules: MatrixEntry[]
  aliases: [string, string][]
  mrows: MatrixEntry[]
  required: [string, string[]][]
  problems: string[]
}
export const OUT: string
export const SEED: { findings: Record<string, Entry>; rules: Record<string, Entry>; mrows: Record<string, Entry> }
export const POAM: string
export function mappingRows(audit: string): string[]
export function aliases(audit: string): [string, string][]
export const NAMED: Record<string, { title?: RegExp; file?: RegExp; exists?: string; wp?: string }>
export const PENDING_WPS: Set<string>
export const ID: RegExp
export function expand(test: string): string[]
export function requiredIds(audit: string): string[]
export function titles(text: string, file: string): string[]
export function testFiles(root?: string): string[]
export function evidence(filesTitles: [string, string[]][], exists?: (path: string) => boolean): Map<string, string[]>
export function build(filesTitles: [string, string[]][], audit: string, exists?: (path: string) => boolean, poam?: string): Matrix
export function toYaml(m: Matrix): string

export interface EvidenceRow {
  id: string
  owner: string
  status: 'passed' | 'manual'
  files: string[]
  step?: string
}
export interface RunResult {
  passed: EvidenceRow[]
  manual: EvidenceRow[]
  problems: string[]
}
export interface RunContext {
  commit: string
  job: string
  run: string | null
  workflow: string | null
  repository: string | null
}
export const MANUAL_FILES: [RegExp, string][]
export const LAB_STEPS: Record<string, string>
export function manualStep(files: string[]): string | null
export function reportTitles(report: unknown, root?: string): [string, string[]][]
export function verifyRun(matrix: Matrix, staticEvidence: Map<string, string[]>, runEvidence: Map<string, string[]>): RunResult
export function runContext(env?: Record<string, string | undefined>, root?: string): RunContext
export function evidenceDocument(result: RunResult, context: RunContext): RunContext & { generated: string; results: EvidenceRow[] }
export function evidenceReport(result: RunResult): string
