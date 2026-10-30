/**
 * Block text as a search result's snippet shows it: one line, so a line break (code blocks) and an
 * inline leaf's placeholder (hard breaks) read as a space. A replace compares a pick's matched text,
 * cut from the snippet, against the block's own text through this.
 */
export function snippetText(text: string): string {
  return text.replace(/[￼\n]/g, ' ')
}
