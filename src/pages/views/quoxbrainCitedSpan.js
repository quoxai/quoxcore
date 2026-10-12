// BRAIN2-W7 E 134: reveal the exact cited passage. Offsets are character offsets
// into the note body as the note API serves it (the same space as ?range=a:b).

export function normalizeSpan(span) {
  if (!span || !Number.isFinite(span.charStart) || !Number.isFinite(span.charEnd)) return null
  if (span.charStart < 0 || span.charEnd <= span.charStart) return null
  return { charStart: span.charStart, charEnd: span.charEnd }
}

// What the reader needs next for a span: 'ready' (within the loaded body),
// 'load' (loaded body stops short of the span end, fetch up to `end`), or 'none'.
export function spanLoadState(span, loadedLen, truncated) {
  const s = normalizeSpan(span)
  if (!s) return { state: 'none' }
  if (s.charEnd <= loadedLen) return { state: 'ready' }
  if (truncated) return { state: 'load', start: loadedLen, end: s.charEnd }
  return { state: 'none' }
}

// The passage text, or null when the loaded body does not cover the span.
export function citedPassage(body, span) {
  const s = normalizeSpan(span)
  if (!s || typeof body !== 'string' || s.charEnd > body.length) return null
  return body.slice(s.charStart, s.charEnd)
}

// BRAIN2-W7 E 133: "Ask about this note" binds the note id, so Cortex can read the
// selected note rather than guess from a possibly duplicated title.
export function buildAskAboutNoteSeed(n) {
  const title = n?.title ? `"${n.title}"` : 'this note'
  const id = n?.id ? ` (noteId: ${n.id})` : ''
  return `About the note ${title}${id}: `
}
