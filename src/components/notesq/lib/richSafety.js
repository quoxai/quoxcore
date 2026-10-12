/**
 * TipTap-free Rich-mode safety helpers. Kept in their own module so deciding
 * the editor mode never pulls the TipTap chunk or builds a second editor.
 */
export const normalise = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')

// Constructs Rich mode does not model. Any of these => open in Markdown mode,
// because Rich editing would drop or mangle them on the next save.
const UNSUPPORTED = [
  /<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>/,      // raw HTML (block or inline)
  /^\s*\|.*\|\s*$/m,                        // tables
  /\[\^[^\]]+\]/,                           // footnotes
  /^\s*\[[^\]]+\]:\s*\S+/m,                 // reference-style link definitions
]

export const hasUnsupported = (md) => UNSUPPORTED.some((re) => re.test(String(md ?? '')))

// The words, URLs and code a reader sees, with markdown punctuation and
// whitespace removed, so `_x_` == `*x*` and `* a` == `- a`, but any dropped
// or changed text is caught.
export const contentOf = (md) => normalise(md)
  .replace(/^(=+|-+)\s*$/gm, '')            // setext underlines
  .replace(/[*_~`#>\-+=|\\]/g, '')
  .replace(/^\s*\d+\.\s/gm, '')
  .replace(/\s+/g, '')
