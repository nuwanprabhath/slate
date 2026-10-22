import type { SectionProps } from '../registry'
import { CheckboxSetting } from '../fields/CheckboxSetting'

export function AutocorrectSection({ settings, patch }: SectionProps) {
  return (
    <>
      <CheckboxSetting
        testId="setting-auto-bullets"
        label={<>Start a bulleted list when I type <code>* </code></>}
        help="At the start of a line."
        checked={settings.autoBullets}
        onChange={(autoBullets) => patch({ autoBullets })}
      />
      <CheckboxSetting
        testId="setting-markdown-shortcuts"
        label={<>Markdown shortcuts (<code>-</code>, <code>1.</code>, <code>#</code>, <code>```</code>)</>}
        help="Lists, headings and code blocks from what you type. Off, they come only from the toolbar and menus."
        checked={settings.markdownShortcuts}
        onChange={(markdownShortcuts) => patch({ markdownShortcuts })}
      />
    </>
  )
}
