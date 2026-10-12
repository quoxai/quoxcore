/**
 * Safety net for Rich mode: parse markdown into the TipTap doc and serialise it
 * back, headlessly. A note only opens in Rich mode when this returns the same
 * text, so rich editing can never silently rewrite a note (HTML blocks, tables,
 * footnotes and other constructs NotesQ does not model fall back to Markdown mode).
 */
import { Editor } from '@tiptap/core'
import { buildExtensions } from './richExtensions'
import { hasUnsupported, contentOf } from './richSafety'

export { hasUnsupported, contentOf }

export const normalise = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')

export function roundTrip(markdown) {
  const editor = new Editor({ extensions: buildExtensions(), content: markdown, contentType: 'markdown', element: null })
  try { return editor.getMarkdown() } finally { editor.destroy() }
}

export function isLossless(markdown) {
  try { return normalise(roundTrip(markdown)) === normalise(markdown) } catch { return false }
}

/**
 * Owner direction 2026-10-03: users must not be pushed into raw markdown, so
 * Rich is safe whenever the note's CONTENT survives a round trip (harmless
 * syntax variants are normalised on the next save), and refused only for
 * constructs Rich cannot model or when any text would change.
 */
export function isRichSafe(markdown) {
  const md = String(markdown ?? '')
  if (hasUnsupported(md)) return false
  try { return contentOf(roundTrip(md)) === contentOf(md) } catch { return false }
}
