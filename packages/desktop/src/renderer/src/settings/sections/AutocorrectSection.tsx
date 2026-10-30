import type { SectionProps } from '../registry'
import { CheckboxSetting } from '../fields/CheckboxSetting'
import { SPELLCHECK_UNAVAILABLE_HELP, spellcheckAvailable } from '../../../../shared/settings/spellcheck'

export function AutocorrectSection({ settings, patch }: SectionProps) {
  const spelling = spellcheckAvailable(window.slate.chrome.platform)
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
      <CheckboxSetting
        testId="setting-link-pasted-urls"
        label="Make pasted web addresses links"
        help="Web, mail and www. addresses. Paste as plain text leaves them as text."
        checked={settings.linkPastedUrls}
        onChange={(linkPastedUrls) => patch({ linkPastedUrls })}
      />
      <CheckboxSetting
        testId="setting-spellcheck-underline"
        label="Underline misspelled words"
        help={spelling ? 'Slate never corrects them for you.' : SPELLCHECK_UNAVAILABLE_HELP}
        checked={spelling && settings.spellcheckUnderline}
        disabled={!spelling}
        onChange={(spellcheckUnderline) => patch({ spellcheckUnderline })}
      />
    </>
  )
}
