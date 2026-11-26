/**
 * The consent model behind `gdprStrictMode` (GDPR review §3.1): which features may send data off this
 * computer, what each one tells the person before they allow it, and the one pure test of whether a
 * feature may run. Pure, so main, the preload and the renderer all decide the same way.
 */
import type { Settings } from '../api'

export const CONSENT_FEATURES = ['updates', 'gitSync', 'oneDriveSync', 'plaintextSync', 'microsoftSignIn', 'githubSignIn', 'claudeTheme'] as const
export type ConsentFeature = (typeof CONSENT_FEATURES)[number]

export interface ConsentRecord {
  /** ms since epoch */
  grantedAt: number
  /** `DISCLOSURES[feature].textVersion` when granted; a grant for an older text no longer counts. */
  textVersion: number
  /** 'user' from the dialog; 'legacy' synthesised for an existing install's already-configured feature. */
  source: 'user' | 'legacy'
}
export type Consents = Partial<Record<ConsentFeature, ConsentRecord>>

export interface Disclosure {
  title: string
  /** Host names only. */
  endpoints: readonly string[]
  /** Plain-language data types. */
  data: readonly string[]
  recipient: string
  /** Bump whenever this disclosure's wording changes, so earlier grants are asked again. */
  textVersion: number
}

/** From the review's §1.1 (N-1 … N-12, P-2). */
export const DISCLOSURES: Readonly<Record<ConsentFeature, Disclosure>> = {
  updates: {
    title: 'Check for updates automatically',
    endpoints: ['github.com', 'objects.githubusercontent.com'],
    data: ['Your IP address', "Slate's version", 'Your operating system and its version'],
    recipient: 'GitHub, Inc. (USA)',
    textVersion: 1,
  },
  gitSync: {
    title: 'Sync your notes with a git repository',
    endpoints: ['github.com'],
    data: ['Every note and image you sync', 'Your IP address', 'The repository credentials Slate uses'],
    recipient: 'The host of the repository you choose (often GitHub, Inc., USA)',
    textVersion: 1,
  },
  oneDriveSync: {
    title: 'Sync your notes with OneDrive',
    endpoints: ['graph.microsoft.com', 'login.microsoftonline.com'],
    data: ['Every note and image you sync', 'Your IP address', 'Your Microsoft account sign-in'],
    recipient: 'Microsoft Corporation (USA)',
    textVersion: 1,
  },
  plaintextSync: {
    title: 'Sync without encryption',
    endpoints: [],
    data: ['Your notes and images, readable by the sync provider', 'The names of your notebooks, sections and pages'],
    recipient: 'Your sync provider (GitHub or Microsoft, USA)',
    textVersion: 1,
  },
  microsoftSignIn: {
    title: 'Sign in to Microsoft',
    endpoints: ['login.microsoftonline.com', 'graph.microsoft.com'],
    data: ['Your Microsoft account name', 'Your IP address', 'The OneNote pages and images you import'],
    recipient: 'Microsoft Corporation (USA)',
    textVersion: 1,
  },
  githubSignIn: {
    title: 'Sign in to GitHub',
    endpoints: ['github.com', 'api.github.com'],
    data: ['Your GitHub account', 'Your IP address', 'Access to your repositories (the "repo" permission)'],
    recipient: 'GitHub, Inc. (USA)',
    textVersion: 1,
  },
  claudeTheme: {
    title: 'Describe a theme with Claude',
    endpoints: ['api.anthropic.com'],
    data: ['The theme description you type', 'Your current theme colours'],
    recipient: 'Anthropic PBC (USA), through your own claude sign-in',
    textVersion: 1,
  },
}

const FEATURES: ReadonlySet<string> = new Set(CONSENT_FEATURES)

export function isConsentFeature(v: unknown): v is ConsentFeature {
  return typeof v === 'string' && FEATURES.has(v)
}

/** Strict mode off: everything the user configured is allowed. On: only a grant for the current disclosure. */
export function egressAllowed(s: Pick<Settings, 'gdprStrictMode' | 'consents'>, f: ConsentFeature): boolean {
  if (!s.gdprStrictMode) return true
  const record = s.consents[f]
  return record !== undefined && record.textVersion === DISCLOSURES[f].textVersion
}

function consentRecord(v: unknown): ConsentRecord | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const { grantedAt, textVersion, source } = v as Record<string, unknown>
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return undefined
  if (typeof textVersion !== 'number' || !Number.isInteger(textVersion)) return undefined
  if (source !== 'user' && source !== 'legacy') return undefined
  return { grantedAt, textVersion, source }
}

/** The schema's sanitiser: known features with well-formed records, rebuilt so nothing else rides along. */
export function sanitizeConsents(v: unknown): Consents | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || ArrayBuffer.isView(v)) return undefined
  const out: Consents = {}
  for (const f of CONSENT_FEATURES) {
    if (!Object.hasOwn(v, f)) continue
    const record = consentRecord((v as Record<string, unknown>)[f])
    if (record) out[f] = record
  }
  return out
}

/** `ConsentRequired`'s error name (main/privacy/gate.ts); it survives the trip through `ipcRenderer.invoke`. */
export const CONSENT_REQUIRED = 'ConsentRequired'

/** The feature a refused call needs, read from the error `invoke` rejected with; null for any other error. */
export function consentRequiredFeature(e: unknown): ConsentFeature | null {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : ''
  const m = /\bConsentRequired: (\w+) needs consent\b/.exec(text)
  return m && isConsentFeature(m[1]) ? m[1] : null
}

