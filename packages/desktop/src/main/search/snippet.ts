/**
 * About `context` characters either side of `[from, to)`, widened or narrowed to whole words so a
 * result never starts mid-word ("bectl -n api…"); cut ends get an ellipsis. `range` is the match
 * within the returned snippet.
 */
export function snippetAround(text: string, from: number, to: number, context: number): { snippet: string; range: [number, number] } {
  let start = Math.max(0, from - context)
  let end = Math.min(text.length, to + context)
  if (start > 0) {
    // Begin after the first space in the cut, unless there is none before the match.
    const space = text.slice(start, from).search(/\s/)
    if (space !== -1) start += space + 1
  }
  if (end < text.length) {
    const cut = text.slice(to, end)
    const space = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'))
    if (space !== -1) end = to + space
  }
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const snippet = head + text.slice(start, end).replace(/[￼\n]/g, ' ') + tail
  return { snippet, range: [from - start + head.length, to - start + head.length] }
}
