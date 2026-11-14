// What main checks before it acts on an `invoke` argument (review F7, C1). A handler's parameter
// types are erased at run time, so `(_e, docId: string)` acts on whatever the renderer sent: the
// renderer is untrusted (audit B-2), and the registrar only proves the sender and the vault state.
// Hand-written in the style of `isSearchQuery`, so no dependency decides what main accepts.

import type { GitSettings, RendererErrorReport, Settings, SyncConfig } from './api'
import { LIMITS } from './theme/spec'

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

// The grammar lives in core so sync refuses the same ids main does.
// Declared here, not re-exported, because the ipcValidation guard reads this file's declarations.
import { isDocId as coreIsDocId, isId as coreIsId } from '@slate/core'

/** An id as `newId` makes it. */
export const isId = (value: unknown): value is string => coreIsId(value)

/** A document's key in the store: its kind, then an id. */
export const isDocId = (value: unknown): value is string => coreIsDocId(value)

/** A theme the person saved (`main/theme/themeStore.ts`); a `builtin:` theme is not renamed or removed. */
export const isSavedThemeId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('user:') && isId(value.slice('user:'.length))

/** What `docs:list` may ask for: one kind of document, or every document. */
export const isDocPrefix = (value: unknown): value is string => value === '' || value === 'page:' || value === 'notebook:'

export const isText = (value: unknown, max = MAX_STRING): value is string => typeof value === 'string' && value.length <= max

export const isBool = (value: unknown): value is boolean => typeof value === 'boolean'

/** A plain object, so a validated shape is never an array, bytes (a typed array has a key per byte) or a boxed primitive. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)

/**
 * `validateTheme` turns any spec whose JSON is longer than this into the base theme, so a longer one is
 * the renderer misbehaving; refusing it here keeps main from walking megabytes (FX-7).
 */
export const MAX_THEME_SPEC_CHARS = LIMITS.maxInputChars
const MAX_THEME_DEPTH = 8

/**
 * A theme spec's shape: plain objects, arrays, strings, finite numbers, booleans and null, at most
 * `MAX_THEME_DEPTH` deep. Each key, value and string character costs one of `MAX_THEME_SPEC_CHARS`, never
 * more than its JSON does, so every spec `validateTheme` would keep passes; the walk stops at the budget.
 */
export function isThemeSpecShape(value: unknown): value is Record<string, unknown> {
  let budget = MAX_THEME_SPEC_CHARS
  const fits = (v: unknown, depth: number): boolean => {
    budget -= 1
    if (budget < 0) return false
    if (typeof v === 'string') return (budget -= v.length) >= 0
    // `undefined`: an optional field the renderer left unset (`uiFont: undefined`) survives structured clone.
    if (v === null || v === undefined || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (depth >= MAX_THEME_DEPTH) return false
    if (Array.isArray(v)) {
      if (v.length > budget) return false
      for (const item of v) if (!fits(item, depth + 1)) return false
      return true
    }
    if (!isObject(v) || Object.getPrototypeOf(v) !== Object.prototype) return false
    for (const key in v) {
      if (!Object.hasOwn(v, key)) return false
      if ((budget -= key.length) < 0 || !fits(v[key], depth + 1)) return false
    }
    return true
  }
  return isObject(value) && fits(value, 0)
}

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
