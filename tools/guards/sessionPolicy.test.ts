import { describe, expect, it } from 'vitest'
import { read } from './repo'

/**
 * Review C10 (HIGH): the profile policy in force (idle cap, forced lock triggers, throttle) comes from one owner,
 * the open key ring, read where it is used. A second variable that each path that opens a vault must remember to set
 * (unlock, quick unlock, wizard, join, rejoin, finish-migration) was forgotten once, so a FIPS vault opened by the
 * wizard ran with the standard policy. Accepted path: `sessionPolicy()` in `main/index.ts`.
 */
const INDEX = 'packages/desktop/src/main/index.ts'
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The problems with how `text` holds the policy in force; empty when it only derives it. */
export function sessionPolicyProblems(text: string): string[] {
  const src = code(text)
  const problems: string[] = []
  if (/\blet\s+\w*[Pp]olicy\b/.test(src)) problems.push('a mutable policy variable: derive it with sessionPolicy() from the open key ring')
  if (/\b\w*[Pp]olicy\s*=[^=>]/.test(src.replace(/const\s+\w*[Pp]olicy\s*(?::[^=]*)?=/g, ''))) problems.push('an assignment to a policy variable: nothing sets the session policy, it is derived')
  const derived = src.match(/PROFILES\[[^\]]*keyRing[^\]]*\]/g) ?? []
  if (derived.length !== 1) problems.push(`the session policy is derived ${derived.length} times, expected exactly one site (sessionPolicy)`)
  return problems
}

describe('the profile policy in force (review C10)', () => {
  it('main/index.ts derives it at one site and never stores a copy', () => {
    expect(sessionPolicyProblems(read(INDEX))).toEqual([])
  })

  it('the detection fails on the pattern that broke (self-test)', () => {
    expect(sessionPolicyProblems("let sessionPolicy: ProfilePolicy = PROFILES.standard\nsessionPolicy = PROFILES[opened.keyRing.schedule.profile]").length).toBeGreaterThanOrEqual(2)
    expect(sessionPolicyProblems("const sessionPolicy = () => PROFILES[servicesOpen() ? (services().keyRing?.schedule.profile ?? 'standard') : 'standard']")).toEqual([])
  })
})
