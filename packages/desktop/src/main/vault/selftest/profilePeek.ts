// S-4 (audit §4.2): whether this start must run on the FIPS provider, decided before the self-test from files
// nobody has verified yet. Each reader returns null on any error. Reading them unverified can only make the
// self-test stricter (a planted "fips-140-3" makes a module without the provider fail it, which an attacker who
// can write the data folder could cause anyway); the verified header is checked again at unlock (S-4).
import { join } from 'node:path'
import { readJsonCapped } from '../atomic'
import { isProfileId, type ProfileId } from '../profile'
import { parseProfileFloor, PROFILE_FLOOR_FILE, readLocalKeysFloor } from '../profileFloor'

const VAULT_FILE = 'vault.json'
export const POLICY_FILE = 'policy.json'

/** `resources/policy.json` with `{"requireFips": true}`: a managed install that must run approved. */
export async function policyRequiresFips(resourcesPath: string): Promise<boolean | null> {
  try {
    const json = await readJsonCapped(join(resourcesPath, POLICY_FILE))
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
    return (json as { requireFips?: unknown }).requireFips === true
  } catch {
    return null
  }
}

/** The `profile` vault.json names (header v2), without trusting or verifying anything else in it. */
export async function headerProfilePeek(dataDir: string): Promise<ProfileId | null> {
  try {
    const json = await readJsonCapped(join(dataDir, VAULT_FILE))
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
    const profile = (json as { profile?: unknown }).profile
    return isProfileId(profile) ? profile : null
  } catch {
    return null
  }
}

/** The highest profile this device adopted: profile-floor.json, or local-keys.json's own floor (C5 L4). */
export async function profileFloor(dataDir: string): Promise<ProfileId | null> {
  const fromFloor = await (async () => {
    try {
      return parseProfileFloor(await readJsonCapped(join(dataDir, PROFILE_FLOOR_FILE)))?.profile ?? null
    } catch {
      return null
    }
  })()
  if (fromFloor === 'fips-140-3') return fromFloor
  try {
    return (await readLocalKeysFloor(dataDir))?.profile ?? fromFloor
  } catch {
    return fromFloor
  }
}

/** S-4 (a) to (c): any one of them says fips-140-3. */
export async function startRequiresFips(resourcesPath: string, dataDir: string): Promise<boolean> {
  const [policy, header, floor] = await Promise.all([policyRequiresFips(resourcesPath), headerProfilePeek(dataDir), profileFloor(dataDir)])
  return policy === true || header === 'fips-140-3' || floor === 'fips-140-3'
}
