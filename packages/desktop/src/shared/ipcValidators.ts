// What main checks before it acts on an `invoke` argument (review F7, C1). A handler's parameter
// types are erased at run time, so `(_e, docId: string)` acts on whatever the renderer sent: the
// renderer is untrusted (audit B-2), and the registrar only proves the sender and the vault state.
// Hand-written in the style of `isSearchQuery`, so no dependency decides what main accepts.

import type { GitSettings, RendererErrorReport, Settings, SyncConfig } from './api'

/** The most bytes one CRDT update may carry; a page's whole history arrives as many of these. */
export const MAX_UPDATE_BYTES = 16 * 1024 * 1024
/** The cap on an argument that is free text the person typed or pasted. */
export const MAX_STRING = 10_000
/** A URL, a file path: longer than free text, since a path can be deep. */
export const MAX_PATH = 4096
/** The most entries any list argument may carry. */
export const MAX_LIST = 10_000
/** The most rows `audit:list` will hand back. */
export const MAX_ROWS = 1000

/** The image types `BlobStore.put` stores under their own extension (main/blobs.ts `EXTENSIONS`). */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'] as const
export const GIT_AUTH_MODES = ['system', 'token', 'gh', 'device'] as const
export const SYNC_PROVIDERS = ['onedrive', 'git'] as const
export const RESOLVE_CHOICES = ['merged', 'mine', 'theirs'] as const

/** One refusal text for every channel, so a probe learns only that the request was malformed. */
export class MalformedRequest extends Error {
  override name = 'MalformedRequest'
  constructor(channel: string) {
    super(`Refused a malformed ${channel} request`)
  }
}

/**
 * Where a handler's first statement goes when an argument is wrong: `if (!isDocId(docId)) refuse(CH.docsLoad)`.
 * It returns `never`, so the checks that guard it also narrow the arguments for the rest of the handler.
 */
export function refuse(channel: string): never {
  throw new MalformedRequest(channel)
}

// `crypto.randomUUID`, which is all `newId` returns (packages/core/src/ids.ts).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DOC_KINDS = ['page', 'notebook'] as const

/** An id as `newId` makes it. */
export const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** A document's key in the store: its kind, then an id. */
export function isDocId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const colon = value.indexOf(':')
  return colon > 0 && (DOC_KINDS as readonly string[]).includes(value.slice(0, colon)) && isId(value.slice(colon + 1))
}

/** A theme the person saved (`main/theme/themeStore.ts`); a `builtin:` theme is not renamed or removed. */
export const isSavedThemeId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('user:') && isId(value.slice('user:'.length))

/** What `docs:list` may ask for: one kind of document, or every document. */
export const isDocPrefix = (value: unknown): value is string => value === '' || value === 'page:' || value === 'notebook:'

export const isText = (value: unknown, max = MAX_STRING): value is string => typeof value === 'string' && value.length <= max

export const isBool = (value: unknown): value is boolean => typeof value === 'boolean'

/** A plain object, so a validated shape is never an array or a boxed primitive. */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A whole number of things to return, 1..max. */
export const isCount = (value: unknown, max = MAX_ROWS): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max

export const isBytes = (value: unknown, max: number): value is Uint8Array => isAnyBytes(value) && value.byteLength <= max

/** Bytes whose own cap belongs to the code that stores them (an image: `BlobStore.put`). */
export const isAnyBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array

export const isOneOf = <T extends string>(set: readonly T[], value: unknown): value is T => typeof value === 'string' && (set as readonly string[]).includes(value)

export const isTextList = (value: unknown, each = MAX_STRING, max = MAX_LIST): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => isText(item, each))

/** An argument the renderer may leave out: `undefined` only, never `null` or a wrong type. */
export const optional = <T>(value: unknown, check: (v: unknown) => v is T): value is T | undefined => value === undefined || check(value)

/** The longest `name` and the most frames a renderer error report may carry; `rendererError` trims further. */
const MAX_ERROR_NAME = 200
const MAX_FRAMES = 100
const ERROR_KINDS = ['error', 'unhandledrejection'] as const

/**
 * What the renderer may report about its own crash (`diagnostics:renderer-error`): a kind, an error
 * name and stack frames, and nothing else. Exactly these three keys, so a message or any other field
 * the renderer adds never reaches the log.
 */
export function isRendererErrorReport(value: unknown): value is RendererErrorReport {
  if (!isObject(value) || Object.keys(value).length !== 3) return false
  return isOneOf(ERROR_KINDS, value.kind) && isText(value.name, MAX_ERROR_NAME) && isTextList(value.frames, MAX_PATH, MAX_FRAMES)
}

/** `sanitizePatch` (shared/settings/schema.ts) decides every field; a patch is checked only for its shape. */
export const isSettingsPatch = (value: unknown): value is Partial<Settings> => isObject(value)

export function isGitSettings(value: unknown): value is GitSettings {
  if (!isObject(value)) return false
  return isText(value.remoteUrl, MAX_PATH) && isText(value.branch, 200) && isOneOf(GIT_AUTH_MODES, value.auth)
}

export function isSyncConfig(value: unknown): value is SyncConfig {
  if (!isObject(value)) return false
  if (!(value.provider === null || isOneOf(SYNC_PROVIDERS, value.provider))) return false
  if (value.git !== undefined && !isGitSettings(value.git)) return false
  return optional(value.token, (v): v is string => isText(v, 500))
}

/** The menu path `chrome:invoke-menu` walks: a short list of item indexes. */
export const isMenuPath = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((i) => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < 1000)
