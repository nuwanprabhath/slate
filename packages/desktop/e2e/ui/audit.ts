/**
 * The UI audit: what a person spots at a glance and a functional test never asserts. It runs in the
 * real app window (Playwright Electron, `page.evaluate(auditUi)`) against the real stylesheet and
 * returns one violation per defect, each naming the element. `reviewUi` (./review.ts) fails the
 * scenario on any.
 *
 * Each rule is a yes/no question ("is this broken?"), not a taste call; taste is the lead's
 * screenshot review (.claude/skills/ui-review/SKILL.md). Ported from Apiary's audit, plus the rules
 * for what slipped through in Slate 0.2.0 with every test green: the lock screen's Touch ID button
 * sat left of the card's centre line (`off-centre`), Security's change-password fields ran into each
 * other with their help text overlapping (`crowded`, `overlap`) and their placeholder cut
 * (`placeholder-clipped`), Diagnostics' "Nothing written yet." was squeezed onto three lines
 * (`squeezed-text`), and a banner's button was cut by the title bar (`cut-off`).
 *
 * An element meant to break a rule says so, with a reason of 8 characters or more:
 * `data-ui-allow="clipped-text: a page title, full text in its tooltip"` (several separated by `;`).
 *
 * `auditUi` is passed to `page.evaluate`, which sends its source text into the page: everything it
 * uses must be inside it (no imports, no module-level helpers).
 */

export type UiRule =
  | 'clipped-text'
  | 'cut-off'
  | 'overlap'
  | 'see-through-popup'
  | 'native-control'
  | 'list-marker'
  | 'misaligned-row'
  | 'low-contrast'
  | 'unnamed-control'
  | 'placeholder-clipped'
  | 'crowded'
  | 'off-centre'
  | 'squeezed-text'

export interface UiViolation {
  rule: UiRule
  /** A readable path to the element: testid, role or tag with its classes, and its text. */
  where: string
  detail: string
}

export interface AuditOptions {
  /** CSS selector of the element to audit inside (the default is the whole window). */
  within?: string
}

export function auditUi(opts: AuditOptions = {}): UiViolation[] {
  type Rgba = [number, number, number, number]
  type Rgb = [number, number, number]

  const INTERACTIVE =
    'button, a[href], input, select, textarea, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"]'
  const POPUP = '[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"], [role="alertdialog"], [data-popup]'
  /** Content, not chrome: what the user wrote, where lists, long lines and any colour are theirs. */
  const PROSE = '.ProseMirror, [data-prose], [data-testid="canvas"]'
  /** Controls with a box of their own (fields and buttons), for spacing and centring. */
  const CONTROL = 'button, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), select, textarea'

  const out: UiViolation[] = []
  const root = (opts.within !== undefined ? document.querySelector(opts.within) : null) ?? document.body

  const nameOf = (el: Element): string => {
    const parts: string[] = []
    let cur: Element | null = el
    for (let i = 0; cur !== null && cur !== document.body && i < 3; i++, cur = cur.parentElement) {
      const id = cur.getAttribute('data-testid')
      const role = cur.getAttribute('role')
      const cls = [...cur.classList].slice(0, 2).join('.')
      parts.unshift(id !== null ? `[${id}]` : `${cur.tagName.toLowerCase()}${role !== null ? `[role=${role}]` : ''}${cls !== '' ? `.${cls}` : ''}`)
      if (id !== null) break
    }
    const ph = el.getAttribute('placeholder')
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || (ph ?? '')
    return `${parts.join(' > ')}${text !== '' ? ` "${text}"` : ''}`
  }

  const allowed = (el: Element, rule: UiRule): boolean => {
    for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) {
      const allow = cur.getAttribute('data-ui-allow')
      if (allow === null) continue
      for (const entry of allow.split(';')) {
        const at = entry.indexOf(':')
        if (at < 0) continue
        if (entry.slice(0, at).trim() === rule && entry.slice(at + 1).trim().length >= 8) return true
      }
    }
    return false
  }

  const add = (rule: UiRule, el: Element, detail: string): void => {
    if (!allowed(el, rule)) out.push({ rule, where: nameOf(el), detail })
  }

  /** The box `el`'s ancestors let show: the window, cut by every ancestor that clips. */
  const clipBox = (el: Element): DOMRect => {
    let left = 0
    let top = 0
    let right = window.innerWidth
    let bottom = window.innerHeight
    for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) {
      const s = getComputedStyle(cur)
      if (s.position === 'fixed') break
      const clipsX = s.overflowX !== 'visible'
      const clipsY = s.overflowY !== 'visible'
      if (!clipsX && !clipsY) continue
      const r = cur.getBoundingClientRect()
      if (clipsX) {
        left = Math.max(left, r.left)
        right = Math.min(right, r.right)
      }
      if (clipsY) {
        top = Math.max(top, r.top)
        bottom = Math.min(bottom, r.bottom)
      }
    }
    return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
  }

  const visible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false
    if (el.closest('[aria-hidden="true"], [inert], [hidden]') !== null) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) {
      const s = getComputedStyle(cur)
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) === 0) return false
    }
    const c = clipBox(el)
    return r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom
  }

  /** Inside a list that scrolls, being partly scrolled out of view is normal, not a defect. */
  const inScroller = (el: Element): boolean => {
    for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) {
      const s = getComputedStyle(cur)
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) return true
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) return true
    }
    return false
  }

  const ownText = (el: Element): string => {
    let t = ''
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? ''
    return t.trim()
  }

  const rgba = (color: string): Rgba => {
    const m = /rgba?\(([^)]+)\)/.exec(color)
    if (m === null) return [0, 0, 0, 0]
    const p = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
  }

  const effectiveBackground = (el: Element): Rgb => {
    const layers: Rgba[] = []
    for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) {
      const c = rgba(getComputedStyle(cur).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let acc: Rgb = [0, 0, 0]
    const html = rgba(getComputedStyle(document.documentElement).backgroundColor)
    if (html[3] > 0) acc = [html[0], html[1], html[2]]
    for (const [r, g, b, a] of layers.reverse()) acc = [r * a + acc[0] * (1 - a), g * a + acc[1] * (1 - a), b * a + acc[2] * (1 - a)]
    return acc
  }

  const luminance = ([r, g, b]: Rgb): number => {
    const ch = (v: number): number => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
  }

  const contrast = (a: Rgb, b: Rgb): number => {
    const la = luminance(a)
    const lb = luminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  /** The browser's own look for a control, from inside a shadow root no app stylesheet reaches. */
  const uaDefault = (el: HTMLElement): { background: string; border: string } => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.append(host)
    const probe = document.createElement(el.tagName.toLowerCase())
    if (el instanceof HTMLInputElement) probe.setAttribute('type', el.type)
    host.attachShadow({ mode: 'open' }).append(probe)
    const s = getComputedStyle(probe)
    const res = { background: s.backgroundColor, border: `${s.borderTopStyle} ${s.borderTopWidth} ${s.borderTopColor}` }
    host.remove()
    return res
  }

  /** Drawn as a box: a visible border or background, so touching another box reads as crowded. */
  const boxed = (el: Element): boolean => {
    const s = getComputedStyle(el)
    const border = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && rgba(s.borderTopColor)[3] > 0.05
    return border || rgba(s.backgroundColor)[3] > 0.05
  }

  /** Laid out by the page itself, so a variable font measures as it renders (a canvas does not). */
  const textWidth = (text: string, s: CSSStyleDeclaration): number => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;visibility:hidden'
    probe.style.font = s.font
    probe.style.letterSpacing = s.letterSpacing
    probe.style.fontVariationSettings = s.fontVariationSettings
    probe.textContent = text
    document.body.append(probe)
    const w = probe.getBoundingClientRect().width
    probe.remove()
    return w
  }

  const all = [...root.querySelectorAll('*')].filter(visible)
  const layerOf = (el: Element): Element | null => el.closest(POPUP)

  for (const el of all) {
    if (!(el instanceof HTMLElement)) continue
    const s = getComputedStyle(el)
    const inProse = el.closest(PROSE) !== null
    const text = ownText(el)

    // Text cut by its own box: allowed only where the full text is one hover away and 5em still shows.
    if (!inProse && text !== '' && el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') {
      const full = (el.textContent ?? '').trim()
      const hint = el.closest('[title], [aria-label]')
      const hinted = hint !== null && `${hint.getAttribute('title') ?? ''}${hint.getAttribute('aria-label') ?? ''}`.includes(full.slice(0, 12))
      const roomy = el.clientWidth >= parseFloat(s.fontSize) * 5
      if (!hinted || !roomy) add('clipped-text', el, `shows ${String(el.clientWidth)}px of ${String(el.scrollWidth)}px${hinted ? '' : ', and the full text is not in a tooltip'}`)
    }

    // A placeholder wider than the field: "The same password ag" tells nobody what to type.
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder !== '' && el.value === '') {
      const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - (el.type === 'search' ? 16 : 0)
      const need = textWidth(el.placeholder, s)
      if (el instanceof HTMLInputElement && need > room + 1) add('placeholder-clipped', el, `placeholder needs ${String(Math.ceil(need))}px, the field shows ${String(Math.floor(room))}px`)
    }

    // A short status or help text wrapped onto three or more lines: its column is squeezed.
    if (!inProse && text !== '' && text.split(/\s+/).length <= 6 && el.children.length === 0) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)))
      if (tops.size >= 3) add('squeezed-text', el, `${String(text.split(/\s+/).length)} words on ${String(tops.size)} lines in a ${String(Math.round(el.getBoundingClientRect().width))}px box`)
    }

    if (el.tagName === 'LI' && !inProse && s.display === 'list-item' && s.listStyleType !== 'none') {
      add('list-marker', el, `shows a "${s.listStyleType}" marker; chrome lists use list-style: none`)
    }

    if (el.matches(INTERACTIVE) && !inProse) {
      if (!inScroller(el)) {
        const r = el.getBoundingClientRect()
        const c = clipBox(el)
        const over = Math.max(c.left - r.left, r.right - c.right, c.top - r.top, r.bottom - c.bottom)
        if (over > 1) add('cut-off', el, `${String(Math.round(over))}px of it is outside what its container shows`)
      }
      if (el.matches('button, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), select, textarea')) {
        const ua = uaDefault(el)
        const border = `${s.borderTopStyle} ${s.borderTopWidth} ${s.borderTopColor}`
        if (s.backgroundColor === ua.background && border === ua.border && rgba(ua.background)[3] > 0) {
          add('native-control', el, "has the browser's default background and border; use the app's controls (.btn, controls.css)")
        }
      }
      if ((el.textContent ?? '').trim() === '' && el.matches('button, a[href], [role^="menuitem"]')) {
        const name = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('aria-labelledby')
        if (name === null || name.trim() === '') add('unnamed-control', el, 'icon-only, with no aria-label or title')
      }
    }

    if (el.matches(POPUP)) {
      let floating = el.matches(':modal, :popover-open')
      for (let cur: Element | null = el; cur !== null && cur !== document.body && !floating; cur = cur.parentElement) floating = ['absolute', 'fixed'].includes(getComputedStyle(cur).position)
      const bg = rgba(s.backgroundColor)
      const blurred = /blur\(\s*([\d.]+)px/.exec(s.backdropFilter)
      const opaque = bg[3] >= 0.9 || (blurred !== null && parseFloat(blurred[1] ?? '0') >= 8 && bg[3] >= 0.55)
      if (floating && !opaque) add('see-through-popup', el, `background ${s.backgroundColor}, backdrop-filter ${s.backdropFilter}: what is behind shows through`)
    }

    if (!inProse && text !== '' && el.closest(':disabled, [aria-disabled="true"]') === null) {
      const fg = rgba(s.color)
      const bg = effectiveBackground(el)
      const shown: Rgb = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])]
      let opacity = 1
      for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) opacity *= parseFloat(getComputedStyle(cur).opacity)
      const ratio = contrast(shown, bg) * opacity
      if (ratio < 3) add('low-contrast', el, `contrast ${ratio.toFixed(2)}:1 against its background (needs 3:1)`)
    }
  }

  // A toolbar's controls sit on one line.
  for (const bar of root.querySelectorAll('[role="toolbar"]')) {
    if (!visible(bar)) continue
    const items = [...bar.children].filter((c) => visible(c) && !['absolute', 'fixed'].includes(getComputedStyle(c).position))
    const centres = items.map((c) => {
      const r = c.getBoundingClientRect()
      return r.top + r.height / 2
    })
    const first = centres[0]
    if (first === undefined) continue
    // A toolbar that wraps has several lines; each item is compared with the line it is on.
    items.forEach((c, i) => {
      const mine = centres[i] ?? first
      const line = centres.filter((y) => Math.abs(y - mine) < 10)
      const ref = line[0] ?? mine
      const off = Math.abs(mine - ref)
      if (off > 2) add('misaligned-row', c, `${String(Math.round(off))}px off the toolbar's line`)
    })
  }

  const controls = all.filter((el) => el.matches(CONTROL) && el.closest(PROSE) === null)
  const sameRow = (a: Element, b: Element): boolean => {
    let up: Element | null = a.parentElement
    for (let i = 0; up !== null && i < 3; i++, up = up.parentElement) {
      if (!up.contains(b)) continue
      let depth = 0
      for (let cur = b.parentElement; cur !== null && cur !== up; cur = cur.parentElement) depth++
      return depth < 3
    }
    return false
  }
  for (let i = 0; i < controls.length; i++) {
    const a = controls[i]
    if (a === undefined) continue
    const ra = a.getBoundingClientRect()
    for (let j = 0; j < controls.length; j++) {
      const b = controls[j]
      if (b === undefined || i === j || a.contains(b) || b.contains(a) || layerOf(a) !== layerOf(b)) continue
      const rb = b.getBoundingClientRect()
      const vOverlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      const hOverlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)

      // Side by side on one line, controls share a centre line (toolbars are checked above).
      if (a.closest('[role="toolbar"]') === null && sameRow(a, b)) {
        const gap = rb.left - ra.right
        const sameLine = vOverlap > Math.min(ra.height, rb.height) / 2
        if (gap >= 0 && gap <= 24 && Math.max(ra.height, rb.height) <= 48 && sameLine) {
          const off = Math.abs(ra.top + ra.height / 2 - (rb.top + rb.height / 2))
          if (off > 2) add('misaligned-row', b, `${String(Math.round(off))}px off the centre line of ${nameOf(a)} beside it`)
        }
      }

      // Two boxed controls touching or overlapping: borders run into each other. Once per pair.
      if (j > i && boxed(a) && boxed(b)) {
        const hGap = Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right)
        const vGap = Math.max(ra.top, rb.top) - Math.min(ra.bottom, rb.bottom)
        if (vOverlap > 0 && hGap < 4 && hOverlap < Math.min(ra.width, rb.width)) add('crowded', a, `${hGap < 0 ? `overlaps by ${String(Math.round(-hGap))}px` : `${String(Math.round(hGap))}px`} beside ${nameOf(b)} (needs 4px)`)
        else if (hOverlap > 0 && vGap < 4 && vOverlap < Math.min(ra.height, rb.height)) add('crowded', a, `${vGap < 0 ? `overlaps by ${String(Math.round(-vGap))}px` : `${String(Math.round(vGap))}px`} above or below ${nameOf(b)} (needs 4px)`)
      }
    }
  }

  // In a centred column, a narrower control off the column's centre line looks dropped there; so does
  // one that is neither centred nor on its siblings' left edge. A wrapper holding only one control
  // stands for that control (the lock screen's quick-unlock row).
  const leadControl = (child: Element): Element => {
    if (child.matches(CONTROL)) return child
    const inner = [...child.children].filter(visible)
    const only = inner.length === 1 ? inner[0] : undefined
    return only !== undefined && only.matches(CONTROL) && ownText(child) === '' ? only : child
  }
  for (const col of all) {
    const s = getComputedStyle(col)
    const flexCol = s.display.includes('flex') && s.flexDirection.startsWith('column')
    const textCentred = !s.display.includes('flex') && !s.display.includes('grid') && s.textAlign === 'center'
    if (!flexCol && !textCentred) continue
    const r = col.getBoundingClientRect()
    const contentLeft = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft)
    const contentRight = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight)
    const centre = (contentLeft + contentRight) / 2
    const width = contentRight - contentLeft
    const items = [...col.children]
      .filter((c) => visible(c) && !['absolute', 'fixed'].includes(getComputedStyle(c).position))
      .map(leadControl)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
    // Only the ones narrower than the column say how it aligns; a full-width one is both.
    const narrow = items.filter(({ r: b }) => b.width < width - 4)
    if (narrow.length === 0) continue
    const isCentred = (b: DOMRect): boolean => Math.abs(b.left + b.width / 2 - centre) <= 2
    const isLeft = (b: DOMRect): boolean => Math.abs(b.left - contentLeft) <= 2
    const centredMode = (flexCol && s.alignItems === 'center') || textCentred || narrow.some(({ r: b }) => isCentred(b) && !isLeft(b))
    for (const { el, r: b } of narrow) {
      if (!el.matches(CONTROL)) continue
      if (centredMode && !isCentred(b)) add('off-centre', el, `its centre is ${String(Math.round(b.left + b.width / 2 - centre))}px off its centred column's`)
      else if (!centredMode && !isLeft(b) && !isCentred(b) && narrow.some(({ r: o }) => isLeft(o))) add('off-centre', el, `${String(Math.round(b.left - contentLeft))}px in from the left edge its siblings share`)
    }
  }

  // Two controls, or two texts, drawn over each other in the same layer.
  const leaves = all.filter((el) => el.matches(INTERACTIVE) || (ownText(el) !== '' && el.closest(PROSE) === null))
  /**
   * What `el` draws that another thing could cover, as boxes: a field's content box (inside its
   * padding, where an inline toggle may sit), else each line of its own text (a card's corner action
   * is not over the card's words, and a wrapped span's lines are not one rectangle), else its box.
   * Each is cut to what its ancestors let show: a row scrolled half out of its list is not over the
   * header above the list.
   */
  const drawn = (el: Element): DOMRect[] => {
    const r = el.getBoundingClientRect()
    let boxes: DOMRect[] = []
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const s = getComputedStyle(el)
      const left = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft)
      const right = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight)
      boxes = [new DOMRect(left, r.top, Math.max(0, right - left), r.height)]
    } else {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim() === '') continue
        const control = n.parentElement?.closest(INTERACTIVE) ?? null
        if (control !== null && control !== el && el.contains(control)) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const t of range.getClientRects()) if (t.width > 0 && t.height > 0) boxes.push(t)
      }
      if (boxes.length === 0) boxes = [r]
    }
    const c = clipBox(el)
    return boxes.map((b) => {
      const left = Math.max(b.left, c.left)
      const top = Math.max(b.top, c.top)
      return new DOMRect(left, top, Math.max(0, Math.min(b.right, c.right) - left), Math.max(0, Math.min(b.bottom, c.bottom) - top))
    })
  }
  const shapes = new Map(leaves.map((el) => [el, drawn(el)]))
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i]
    if (a === undefined) continue
    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j]
      if (b === undefined || a.contains(b) || b.contains(a) || layerOf(a) !== layerOf(b)) continue
      let worst: [number, number] | null = null
      for (const ra of shapes.get(a) ?? []) {
        for (const rb of shapes.get(b) ?? []) {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
          if (w > 2 && h > 2 && (worst === null || w * h > worst[0] * worst[1])) worst = [w, h]
        }
      }
      if (worst !== null) add('overlap', a, `overlaps ${nameOf(b)} by ${String(Math.round(worst[0]))}×${String(Math.round(worst[1]))}px`)
    }
  }
  return out
}
