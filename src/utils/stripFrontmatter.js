/**
 * Remove a LEADING YAML frontmatter block (---\n...\n---) from markdown.
 * quox#681: notes carry their properties as frontmatter; the reader already
 * shows them as a Properties panel, so rendering the raw block again produced
 * horizontal rules and "collection: ... tags:" text in the body. A --- later in
 * the document is a real horizontal rule and is left alone.
 */
export function stripFrontmatter(markdown) {
  if (typeof markdown !== 'string' || !markdown) return ''
  const m = markdown.match(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/)
  return m ? markdown.slice(m[0].length) : markdown
}

export default stripFrontmatter
