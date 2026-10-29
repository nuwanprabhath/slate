// The ACVP ML-DSA sigVer subset in sigver.h, read for the TypeScript tests (native pq.test.ts, desktop vault/native.test.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SigVerCase {
  tcId: number
  level: 65 | 87
  passed: boolean
  pk: Buffer
  message: Buffer
  context: Buffer
  signature: Buffer
}

/** The ACVP cases in sigver.h: `{tcId, level, passed, pk, message, context, signature}`, hex split over lines. */
export function sigVerCases(): SigVerCase[] {
  const src = readFileSync(join(__dirname, 'sigver.h'), 'utf8')
  const body = src.slice(src.indexOf('MLDSA_SIGVER[] = {'))
  const out: SigVerCase[] = []
  for (const m of body.matchAll(/\{(\d+), (\d+), ([01]),[^\n]*\n((?:\s*"[0-9a-f]*"\s*,?)+)\}/g)) {
    const [pk, message, context, signature] = m[4]!
      .split(',')
      .slice(0, 4)
      .map((f) => Buffer.from([...f.matchAll(/"([0-9a-f]*)"/g)].map((x) => x[1]).join(''), 'hex'))
    out.push({ tcId: Number(m[1]), level: Number(m[2]) as 65 | 87, passed: m[3] === '1', pk: pk!, message: message!, context: context!, signature: signature! })
  }
  return out
}

/** RFC 9881 SubjectPublicKeyInfo: AlgorithmIdentifier id-ml-dsa-65 (…3.18) or -87 (…3.19), no parameters. */
export function spki(level: 65 | 87, pk: Uint8Array): Buffer {
  const prefix = level === 65 ? '308207b2300b0609608648016503040312038207a100' : '30820a32300b060960864801650304031303820a2100'
  return Buffer.concat([Buffer.from(prefix, 'hex'), pk])
}
