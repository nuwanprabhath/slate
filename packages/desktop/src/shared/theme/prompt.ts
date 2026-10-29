import { BUILTIN_THEMES } from './builtins'
import { PALETTE_TOKENS, MATERIALS, TEXTURE_KINDS, EFFECT_KINDS, FONTS, LIMITS, SURFACES, type ThemeSpec, type EffectKind, type Font, type Texture } from './spec'

/**
 * What Claude is asked, and how its answer is read back.
 *
 * The schema is generated from the same allowlists the validator enforces, so the two cannot drift.
 * It is still only a request: the reply goes through `validateTheme` like anything else.
 */

const EFFECT_NOTES: Record<EffectKind, string> = {
  'gradient-drift': 'two soft pools of colour wandering slowly behind the UI; the thing to put behind glass',
  'grain': 'fine, slowly changing film grain behind the UI',
}

const TEXTURE_NOTES: Record<Texture, string> = {
  none: 'a plain page',
  paper: 'a visible paper grain on the page (pair with warm off-white colours)',
  linen: 'a faint woven linen texture on the page',
  dots: 'a dot grid on the page, like a bullet journal',
  vellum: 'a very fine, barely-there paper grain (for quiet, editorial themes)',
}

const FONT_NOTES: Record<Font, string> = {
  system: 'the platform UI font', serif: 'a book serif (Charter, Georgia)', humanist: 'a warm humanist sans', mono: 'the platform monospace',
  'source-serif': 'Source Serif 4, a bundled editorial text serif', inter: 'Inter, a bundled clean geometric sans',
}

const SURFACE_SCHEMA = {
  type: 'object',
  properties: {
    texture: { type: 'string', enum: TEXTURE_KINDS.filter((t) => t !== 'none') },
    gradient: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: [...PALETTE_TOKENS] },
        to: { type: 'string', enum: [...PALETTE_TOKENS] },
        angle: { type: 'number', minimum: LIMITS.angle.min, maximum: LIMITS.angle.max },
      },
      required: ['from', 'to', 'angle'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

export const THEME_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: LIMITS.maxNameChars },
    palette: {
      type: 'object',
      properties: Object.fromEntries(PALETTE_TOKENS.map((n) => [n, { type: 'string', pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' }])),
      additionalProperties: false,
    },
    material: { type: 'string', enum: [...MATERIALS] },
    texture: { type: 'string', enum: [...TEXTURE_KINDS] },
    font: { type: 'string', enum: [...FONTS] },
    uiFont: { type: 'string', enum: [...FONTS] },
    glass: {
      type: 'object',
      properties: {
        saturation: { type: 'number', minimum: LIMITS.saturation.min, maximum: LIMITS.saturation.max },
        highlight: { type: 'number', minimum: 0, maximum: 1 },
        refraction: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['saturation', 'highlight', 'refraction'],
      additionalProperties: false,
    },
    surfaces: {
      type: 'object',
      properties: Object.fromEntries(SURFACES.map((s) => [s, SURFACE_SCHEMA])),
      additionalProperties: false,
    },
    effects: {
      type: 'array',
      maxItems: LIMITS.maxEffects,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...EFFECT_KINDS] },
          color: { type: 'string', enum: [...PALETTE_TOKENS] },
          intensity: { type: 'number', minimum: 0, maximum: 1 },
          speed: { type: 'number', minimum: 0, maximum: 1 },
          density: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['kind', 'intensity', 'speed', 'density'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'palette', 'material', 'texture', 'font', 'effects'],
  additionalProperties: false,
} as const

export const MAX_REQUEST_CHARS = 2000

export function buildThemePrompt({ request, current }: { request: string; current: ThemeSpec | null }): string {
  const examples = BUILTIN_THEMES.map((b) => JSON.stringify({ ...b.spec, version: undefined })).join('\n')
  return [
    'You design colour themes for Slate, a free-form notes app: a sidebar of notebooks, sections and pages,',
    'a formatting toolbar, and a page canvas where notes sit in boxes.',
    'Reply with one theme as JSON matching the provided schema, and nothing else.',
    '',
    'Palette tokens (give all of them):',
    '- bg: the window. page: the canvas notes sit on. panel / panel-2: code blocks, handles, raised areas.',
    '- toolbar-bg, sidebar-bg, popover (menus), overlay (dim behind dialogs), box-bg / box-border (a note box).',
    '- border, text, muted (secondary text), accent (buttons, highlights), accent-contrast (text on accent), link,',
    '  selection, hover, selected, danger, warning (private-box marker), find-match, find-current, scrollbar-thumb,',
    '  code-keyword, code-string, code-number, code-comment, code-title (syntax colours on panel),',
    '  control-bg / control-border (form fields and buttons: their fill, and the edge that shows where they are).',
    '',
    'Rules:',
    '- Colours as #rrggbb or #rrggbbaa. Body text must read at 4.5:1 or better on page, panel, toolbar-bg and',
    '  sidebar-bg; muted at 3:1; control-border at 3:1 on panel, bg and popover. Slate adjusts any colour that does not.',
    '- material "solid": bg, page, panel, toolbar-bg, sidebar-bg and popover opaque.',
    '- material "glass": page, toolbar-bg and sidebar-bg translucent (alpha about 0xa0-0xd0) over a dark or light bg,',
    '  with a gradient-drift effect behind them so the glass has something to show. Popover stays nearly opaque.',
    '- At most 2 effects; keep intensities moderate so notes stay easy to read. Effect "color" names a palette token.',
    '- glass (optional, only with material "glass"): saturation 0.5-2 of what shows through (liquid glass about 1.4-1.8),',
    '  highlight 0-1 (bright rim and sheen on pane edges), refraction 0-1 (lens band inside the edge).',
    '- surfaces (optional): sidebar and toolbar may each have a texture and/or a gradient {from, to, angle 0-360}.',
    '  from and to name palette tokens (never raw colours); keep the two ends close so text reads on both.',
    '- uiFont (optional): the font of menus and the sidebar; font is the note text.',
    '- name: a short evocative theme name.',
    '',
    'Textures:', ...TEXTURE_KINDS.map((t) => `- ${t}: ${TEXTURE_NOTES[t]}`),
    'Fonts:', ...FONTS.map((f) => `- ${f}: ${FONT_NOTES[f]}`),
    'Effects:', ...EFFECT_KINDS.map((e) => `- ${e}: ${EFFECT_NOTES[e]}`),
    '',
    'Examples of good themes:',
    examples,
    '',
    ...(current !== null
      ? ['The current theme, to adjust as asked (return the whole adjusted theme):', JSON.stringify({ ...current, version: undefined }), '', 'Adjustment requested:']
      : ['Theme requested:']),
    request.slice(0, MAX_REQUEST_CHARS),
  ].join('\n')
}

/** The first balanced `{…}` in `text`, honouring strings, or null. */
function firstObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i += 1
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

function parse(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null

/**
 * The theme object in `claude -p --output-format json` output, or null. `structured_output` is
 * what `--json-schema` produces; `result` is the fallback, as bare JSON, a fenced block, or an
 * object somewhere in prose.
 */
export function extractThemeJson(stdout: string): unknown {
  const envelope = parse(stdout.trim())
  if (!isObject(envelope)) return null
  const e = envelope as Record<string, unknown>
  if (e.is_error === true) return null
  if (isObject(e.structured_output)) return e.structured_output
  if (typeof e.result !== 'string') return null
  const direct = parse(e.result.trim())
  if (isObject(direct)) return direct
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(e.result)
  const f = fenced === null ? undefined : parse(fenced[1]!.trim())
  if (isObject(f)) return f
  const obj = firstObject(e.result)
  const o = obj === null ? undefined : parse(obj)
  return isObject(o) ? o : null
}
