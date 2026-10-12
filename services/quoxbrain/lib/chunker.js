// chunker.js — heading-aware recursive note chunker (P1a, roadmap QUOXBRAIN
// next-level reshape, docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §1).
//
// Pure function, NO DB, NO fs, NO network — mirrors lib/vaultParser.js's
// contract (caller hands us the already-parsed note; we never throw on
// weird input, we degrade instead).
//
// Strategy (decided in the contract — semantic chunking explicitly out of
// scope): heading-aware recursive split, 200-300 TOKEN target per chunk,
// ~15% overlap between consecutive chunks, NEVER split inside a fenced code
// block (a fence that alone exceeds the target is kept whole as one
// oversize chunk rather than broken).
//
// Token approximation: this codebase has no tokenizer dependency, so we
// approximate `tokenCount = ceil(chars / 4)` (roughly matches GPT/Claude
// BPE tokenizers for English prose within ~10-15%). Good enough for a
// chunk-sizing heuristic; NOT used for anything billing-accurate.
//
// Algorithm (single pass over the note body):
//  1. Walk the body line-by-line, classifying runs of lines into ordered
//     "atoms": `heading` (a single `#`..`######` line), `fence` (an entire
//     fenced code block ``` or ~~~, delimiters included, kept atomic even
//     if unterminated — an unclosed fence swallows to EOF rather than risk
//     splitting inside it), or `text` (everything else).
//  2. A running heading stack builds the "H1 > H2 > H3" breadcrumb
//     (`heading_path`) — updated whenever a `heading` atom is seen. Heading
//     lines themselves are NOT included in any chunk's `text` (the
//     breadcrumb already carries that information as structured metadata;
//     see indexedText() below for where title/heading context gets
//     re-attached for indexing).
//  3. Content atoms are greedily accumulated into a running chunk buffer.
//     `text` atoms are further sliced at whitespace boundaries (never
//     mid-word) so the accumulator can land close to the ~250 token target;
//     `fence` atoms are never sliced. Each atom forces a flush before
//     overflowing MAX_CHARS. A fence atom that is itself larger than
//     MAX_CHARS is flushed as its own oversize chunk.
//  4. Each chunk after the first is seeded with ~15% of the previous
//     chunk's tail text (character-based) for retrieval continuity —
//     `heading_path` and `char_start`/`char_end` refer to the chunk's OWN
//     (non-overlap) span; the overlap text is a look-behind prefix baked
//     into `text` for BM25/embedding purposes, not a claim that
//     `body.slice(charStart, charEnd) === text`.
//
// The STABLE chunk id (sha1(noteId \0 headingPath \0 ordinal)) is computed
// by the caller (lib/vaultStore.js replaceNoteChunks), not here — this
// module only assigns `ordinal` (a monotonic per-note counter, so repeated
// heading_path values still get unique, stable ids downstream).

import { createHash } from 'node:crypto'

const CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 250
const MAX_TOKENS = 300
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN // 1000
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN // 1200
const OVERLAP_RATIO = 0.15

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/
const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})/

function tokensOf(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN)
}

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * Splits `body` into an ordered list of `heading` / `fence` / `text` atoms
 * with exact char offsets into `body`. Never throws — malformed fences
 * (unterminated) swallow to EOF rather than risk a mis-split.
 */
function scanAtoms(body) {
  const lines = body.split('\n')

  // Exact per-line char offsets — split('\n') + join('\n') always
  // reconstructs `body` verbatim, so these offsets are trustworthy for
  // char_start/char_end even with no trailing newline.
  const lineStart = new Array(lines.length)
  const lineEnd = new Array(lines.length)
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    lineStart[i] = pos
    lineEnd[i] = pos + lines[i].length
    pos = lineEnd[i] + 1
  }

  // Pass 1: find fence spans (line-index ranges, delimiters included).
  const fenceSpans = []
  let inFence = false
  let fenceChar = null
  let fenceLen = 0
  let fenceStartLine = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inFence) {
      const open = FENCE_OPEN_RE.exec(line)
      if (open) {
        inFence = true
        fenceChar = open[2][0]
        fenceLen = open[2].length
        fenceStartLine = i
      }
      continue
    }
    // Inside a fence: look for a matching (or longer) close of the same char.
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
    if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
      fenceSpans.push({ startLine: fenceStartLine, endLine: i })
      inFence = false
      fenceChar = null
      fenceLen = 0
      fenceStartLine = null
    }
  }
  if (inFence) {
    // Unterminated fence — swallow to EOF rather than risk splitting inside it.
    fenceSpans.push({ startLine: fenceStartLine, endLine: lines.length - 1 })
  }

  const fenceStartByLine = new Map(fenceSpans.map((s) => [s.startLine, s]))

  // Pass 2: build ordered atoms.
  const atoms = []
  let i = 0
  while (i < lines.length) {
    const span = fenceStartByLine.get(i)
    if (span) {
      atoms.push({
        type: 'fence',
        start: lineStart[span.startLine],
        end: lineEnd[span.endLine],
        text: body.slice(lineStart[span.startLine], lineEnd[span.endLine])
      })
      i = span.endLine + 1
      continue
    }

    const heading = HEADING_RE.exec(lines[i])
    if (heading) {
      atoms.push({
        type: 'heading',
        level: heading[1].length,
        title: heading[2].trim(),
        start: lineStart[i],
        end: lineEnd[i]
      })
      i += 1
      continue
    }

    const textStart = i
    while (i < lines.length && !fenceStartByLine.has(i) && !HEADING_RE.exec(lines[i])) {
      i += 1
    }
    const textEndLine = i - 1
    atoms.push({
      type: 'text',
      start: lineStart[textStart],
      end: lineEnd[textEndLine],
      text: body.slice(lineStart[textStart], lineEnd[textEndLine])
    })
  }

  return atoms
}

/** Splits a text atom into whitespace-safe pieces (never mid-word), with exact global offsets. */
function splitIntoWords(atom) {
  const pieces = []
  const re = /\s*\S+/g
  let m
  let consumed = 0
  while ((m = re.exec(atom.text)) !== null) {
    pieces.push({
      text: m[0],
      globalStart: atom.start + m.index,
      globalEnd: atom.start + m.index + m[0].length
    })
    consumed = m.index + m[0].length
  }
  // Trailing whitespace after the last word (not matched by \s*\S+) — fold
  // into the last piece so no char range is silently dropped.
  if (consumed < atom.text.length) {
    if (pieces.length > 0) {
      const last = pieces[pieces.length - 1]
      last.text += atom.text.slice(consumed)
      last.globalEnd = atom.end
    } else {
      // Whitespace-only atom (e.g. a run of blank lines) — nothing to chunk.
      pieces.push({ text: atom.text, globalStart: atom.start, globalEnd: atom.end })
    }
  }
  return pieces
}

/**
 * Chunks a single note's body into heading-aware, token-targeted passages.
 * Never throws — empty/weird input degrades to `[]` or best-effort chunks.
 *
 * @param {{noteId?: string, title?: string, body: string}} args
 * @returns {Array<{ordinal:number, headingPath:string|null, text:string, charStart:number, charEnd:number, tokenCount:number, contentHash:string}>}
 */
export function chunkNote({ noteId, title, body } = {}) {
  const safeBody = typeof body === 'string' ? body : ''
  if (!safeBody.trim()) return []

  let atoms
  try {
    atoms = scanAtoms(safeBody)
  } catch {
    // Should never happen (pure string scanning) — degrade to no chunks
    // rather than crash the ingest pipeline.
    return []
  }

  const chunks = []
  let ordinal = 0

  const headingStack = [] // index = level-1
  let currentHeadingPath = null

  let currentText = ''
  let currentOwnStart = null
  let currentOwnEnd = null
  let currentChunkHeadingPath = null
  let previousTailText = ''

  function flush() {
    if (currentOwnStart === null) return
    const text = currentText
    chunks.push({
      ordinal: ordinal++,
      headingPath: currentChunkHeadingPath,
      text,
      charStart: currentOwnStart,
      charEnd: currentOwnEnd,
      tokenCount: tokensOf(text),
      contentHash: sha1(text)
    })
    const overlapLen = Math.floor(text.length * OVERLAP_RATIO)
    previousTailText = overlapLen > 0 ? text.slice(-overlapLen) : ''
    currentText = ''
    currentOwnStart = null
    currentOwnEnd = null
    currentChunkHeadingPath = null
  }

  function ensureOpenChunk(start) {
    if (currentOwnStart === null) {
      currentText = previousTailText || ''
      currentChunkHeadingPath = currentHeadingPath
      currentOwnStart = start
    }
  }

  for (const atom of atoms) {
    if (atom.type === 'heading') {
      if (currentOwnStart !== null) flush()
      headingStack.length = Math.min(headingStack.length, atom.level - 1)
      headingStack[atom.level - 1] = atom.title
      headingStack.length = atom.level
      currentHeadingPath = headingStack.filter(Boolean).join(' > ') || null
      continue
    }

    if (atom.type === 'fence') {
      const atomTokens = tokensOf(atom.text)
      if (atomTokens > MAX_TOKENS) {
        // Oversize fence: never split it. Close whatever came before, then
        // emit it (with any pending overlap prefix) as its own chunk.
        if (currentOwnStart !== null) flush()
        ensureOpenChunk(atom.start)
        currentText += (currentText ? '\n\n' : '') + atom.text
        currentOwnEnd = atom.end
        flush()
        continue
      }

      if (currentOwnStart !== null && currentText.length + atom.text.length > MAX_CHARS) {
        flush()
      }
      ensureOpenChunk(atom.start)
      currentText += (currentText ? '\n\n' : '') + atom.text
      currentOwnEnd = atom.end
      if (currentText.length >= TARGET_CHARS) flush()
      continue
    }

    // text atom — slice at whitespace boundaries so we never cut mid-word.
    const pieces = splitIntoWords(atom)
    for (const piece of pieces) {
      if (currentOwnStart !== null && currentText.length + piece.text.length > MAX_CHARS) {
        flush()
      }
      ensureOpenChunk(piece.globalStart)
      currentText += piece.text
      currentOwnEnd = piece.globalEnd
      if (currentText.length >= TARGET_CHARS) flush()
    }
  }

  flush()

  return chunks
}

/**
 * Builds the text actually indexed (FTS today, embeddings in P3) for a
 * chunk — prefixes `title` + `headingPath` breadcrumb onto the clean chunk
 * text (the "free tier" of contextual retrieval called out in the
 * contract). `chunk.text` itself stays clean; this is applied at index
 * time only.
 *
 * @param {{headingPath: string|null, text: string}} chunk
 * @param {string} title
 */
export function indexedText(chunk, title) {
  const lines = [title, chunk?.headingPath, chunk?.text].filter((v) => v != null && v !== '')
  return lines.join('\n')
}

export default { chunkNote, indexedText }
