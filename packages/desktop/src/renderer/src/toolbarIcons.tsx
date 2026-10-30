import type { ReactNode, SVGProps } from 'react'

const ACCENT = 'var(--accent)'
const GREY = 'var(--muted)'

function Icon({ children, ...rest }: { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** "A" over a bar in the colour the main button applies. */
export function TextColorIcon({ color }: { color: string }) {
  return (
    <Icon>
      <path d="M5.5 13 10 3l4.5 10M7.2 9.5h5.6" />
      <rect x="3" y="15.5" width="14" height="3" rx="0.5" fill={color} stroke="none" />
    </Icon>
  )
}

/** A slanted marker with its nib at the lower left, over a bar in the highlight colour. */
export function HighlightIcon({ color }: { color: string }) {
  return (
    <Icon>
      <path d="m8 11.5 6.5-6.5a1.4 1.4 0 0 1 2 2L10 13.5Z" />
      <path d="m8 11.5-1 1 2 2 1-1M7 12.5 4.5 14h3" />
      <rect x="3" y="15.5" width="14" height="3" rx="0.5" fill={color} stroke="none" />
    </Icon>
  )
}

/** OneNote's "Clear All Formatting": an A with an eraser at its lower right. */
export function ClearFormattingIcon() {
  return (
    <Icon>
      <path d="M3 14 7.5 3 12 14M4.8 10h5.4" />
      <path d="m12 17 4.5-4.5 2 2L14 19h-2l-1-1Z" fill="#e8738a" stroke="#c94f68" strokeWidth="1" />
    </Icon>
  )
}

export function BulletListIcon() {
  return (
    <Icon>
      {[4, 10, 16].map((y) => (
        <g key={y}>
          <rect x="2.5" y={y - 1.5} width="3" height="3" fill={ACCENT} stroke="none" />
          <path d={`M8.5 ${y}H17.5`} stroke={GREY} />
        </g>
      ))}
    </Icon>
  )
}

export function NumberedListIcon() {
  return (
    <Icon>
      <g stroke={ACCENT} strokeWidth="1.2">
        <path d="M3 2.5 4 2v4" />
        <path d="M2.8 8.6a1.2 1.2 0 0 1 2.2.6c0 .9-2.2 1.8-2.2 2.8H5" />
        <path d="M2.8 14.2h2l-1 1.3a1.1 1.1 0 1 1-1.1 1.6" />
      </g>
      {[4, 10, 16].map((y) => (
        <path key={y} d={`M8.5 ${y}H17.5`} stroke={GREY} />
      ))}
    </Icon>
  )
}

/** A 3×3 grid whose header row is filled, as OneNote's Insert Table. */
export function TableIcon() {
  return (
    <Icon strokeWidth="1.2">
      <rect x="2.5" y="3.5" width="15" height="4" fill="currentColor" />
      <rect x="2.5" y="3.5" width="15" height="13" rx="0.5" />
      <path d="M2.5 12h15M7.5 7.5v9M12.5 7.5v9" />
    </Icon>
  )
}

export function ChevronIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m1.5 3 2.5 2.5L6.5 3" />
    </svg>
  )
}

/** A padlock outline, drawn like the sync status icon. */
export function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  )
}

/** A chevron pointing left (collapse) or right (expand), drawn like ChevronIcon. */
export function SideChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'left' ? 'M6 2 3 5l3 3' : 'm4 2 3 3-3 3'} />
    </svg>
  )
}

/** Three ticked and unticked boxes, drawn like BulletListIcon. */
export function TodoListIcon() {
  return (
    <Icon strokeWidth="1.2">
      {[4, 10, 16].map((y, i) => (
        <g key={y}>
          <rect x="2" y={y - 2} width="4" height="4" rx="0.8" stroke={ACCENT} fill={i === 0 ? ACCENT : 'none'} />
          <path d={`M8.5 ${y}H17.5`} stroke={GREY} strokeWidth="1.5" />
        </g>
      ))}
    </Icon>
  )
}

/** Four lines whose shorter ones sit on the left, in the middle or on the right. */
export function AlignIcon({ align }: { align: 'left' | 'center' | 'right' }) {
  const short = (y: number) => (align === 'left' ? `M3 ${y}H12` : align === 'center' ? `M5.5 ${y}H14.5` : `M8 ${y}H17`)
  return (
    <Icon>
      <path d={`M3 4H17M3 12H17${short(8)}${short(16)}`} />
    </Icon>
  )
}

/** "x" with a small 2 below (subscript) or above (superscript) it. */
export function ScriptIcon({ position }: { position: 'sub' | 'super' }) {
  return (
    <Icon>
      <path d="M3 6.5 10 14.5M10 6.5 3 14.5" />
      <path
        d={position === 'sub' ? 'M12.6 13.6a1.5 1.5 0 0 1 2.9.5c0 1.1-2.9 2-2.9 3.4h3' : 'M12.6 3.6a1.5 1.5 0 0 1 2.9.5c0 1.1-2.9 2-2.9 3.4h3'}
        stroke={ACCENT}
        strokeWidth="1.2"
      />
    </Icon>
  )
}
