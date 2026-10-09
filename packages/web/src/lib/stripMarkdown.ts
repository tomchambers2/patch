// Flatten markdown to plain text for surfaces that render a single line
// verbatim — sidebar titles/previews, native OS toasts — where `**x**`,
// `| a | b |`, `# h`, `[t](url)` etc. must not show as literal syntax.
export function stripMarkdown(s: string): string {
  return s
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // code spans/fences → inner text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → label
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic → inner text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // list bullets
    .replace(/\|/g, ' ') // table pipes
    .replace(/[-=]{3,}/g, ' ') // table delimiter rows / horizontal rules
    .replace(/[*_~`#>]/g, '') // any stray tokens
    .replace(/\s+/g, ' ') // collapse to one line
    .trim();
}
