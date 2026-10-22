/**
 * The Settings dialog's sections, in the order the list shows them.
 *
 * Adding a section is one entry in `SECTIONS` plus one component file in `sections/`. The component
 * gets `SectionProps`; a field writes with `patch`, which saves at once (there is no Save button).
 * Put words people might search for that are not in the label or blurb in `keywords`.
 */
import type { ComponentType } from 'react'
import type { Settings } from '../../../shared/api'
import { SyncSection } from '../sync/SyncSettings'
import { AutocorrectSection } from './sections/AutocorrectSection'
import { GeneralSection } from './sections/GeneralSection'

export interface SectionProps {
  settings: Settings
  /** Writes these settings through `window.slate.settings.set`. */
  patch: (fields: Partial<Settings>) => void
  /** Closes the dialog. */
  onClose: () => void
  onShowConnectAgents: () => void
}

export interface SettingsSection {
  id: string
  label: string
  /** Shown under the section heading, saying what this group of settings is for. */
  blurb: string
  keywords?: string[]
  Component: ComponentType<SectionProps>
}

export const SECTIONS: SettingsSection[] = [
  {
    id: 'autocorrect',
    label: 'Autocorrect',
    blurb: 'What Slate changes as you type. Everything else stays exactly as typed.',
    keywords: ['bullets', 'lists', 'markdown', 'shortcuts', 'headings', 'code'],
    Component: AutocorrectSection,
  },
  {
    id: 'sync',
    label: 'Sync',
    blurb: 'Where your notebooks sync to. Off, Slate never touches the network.',
    keywords: ['git', 'github', 'onedrive', 'repository', 'remote', 'token'],
    Component: ({ onClose }) => <SyncSection onClose={onClose} />,
  },
  {
    id: 'general',
    label: 'General',
    blurb: 'AI agents and the rest.',
    keywords: ['ai', 'agents', 'mcp', 'claude'],
    Component: GeneralSection,
  },
]
