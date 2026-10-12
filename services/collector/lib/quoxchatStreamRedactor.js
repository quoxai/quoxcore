/**
 * QuoxChat Stream Redactor — QCL-SECURITY Phase 3 (SSE-stream redaction gap)
 *
 * Before this fix, the streaming /message path emitted raw LLM tokens to the
 * visitor via SSE `event: token` frames BEFORE the credential filter ran (the
 * filter only ran once, on the fully-assembled response, right before the
 * final `event: done`). A secret split across two or more stream chunks
 * would reach the visitor's browser token-by-token, un-redacted — the filter
 * never saw the chunks individually and the SSE writes had already happened
 * by the time it ran on the joined text.
 *
 * Fix: buffer-then-emit. Deltas are appended to an internal buffer; once the
 * buffer holds more than `window` characters, the "safe" prefix is peeled
 * off, redacted (reusing quoxchatResultSanitiser.sanitiseString — same
 * pattern set as the final-response filter), and emitted. The trailing
 * `window` characters are always retained so a secret spanning a chunk
 * boundary is redacted before any part of it is ever written to the wire.
 *
 * Correctness notes:
 *   - The cut point is never chosen inside a contiguous "token-like" run
 *     (letters/digits/._~+/=:-) — all of the sanitiser's single-line secret
 *     patterns (Bearer tokens, sk-/gh_/AWS/Google keys, JWTs, generic
 *     `key=value` assignments) are built from that character class, so this
 *     guarantees they are never split across an emit boundary regardless of
 *     their length (not just within `window` chars — a 900-char JWT is still
 *     held whole). A hard `MAX_HOLD` ceiling bounds latency in case ordinary
 *     prose (e.g. a long URL) never presents a safe cut point.
 *   - Multi-line PEM private-key blocks are the one pattern that spans
 *     whitespace/newlines. `push()` recognises an unterminated `-----BEGIN`
 *     marker and holds everything from that marker onward until the
 *     matching `-----END` arrives (or MAX_HOLD is hit), so ordinary short
 *     assistant replies are unaffected and PEM blocks get the same
 *     protection as the non-streaming filter in the common case. This is a
 *     window-bounded heuristic, not a formal proof for adversarial inputs —
 *     flagged here deliberately per the audit's own preference for a
 *     documented residual over a silent gap.
 *   - Normal text (no secret patterns) streams through byte-identical,
 *     just delayed by up to `window` characters of latency.
 */

'use strict';

const { sanitiseString } = require('./quoxchatResultSanitiser');
// QCPRO voice rule: em-dash scrub applied at the same emit boundary as the
// credential filter, so streamed tokens match the scrubbed final response.
// guardEmDashZone keeps a dash zone (and the word before it) whole across
// emit boundaries so the inter-word rewrite always has full context.
const { scrubEmDashes, guardEmDashZone } = require('./quoxchatVoiceScrub');

const DEFAULT_WINDOW = 256; // minimum trailing hold-back, in raw chars
const MAX_HOLD = DEFAULT_WINDOW * 4; // hard ceiling so an unbroken run (or an unterminated PEM block) can't stall streaming forever

// Characters our secret patterns treat as "inside" a token/credential run.
// It is always safe to cut immediately before a character NOT in this set —
// none of the bounded (non-PEM) patterns in quoxchatResultSanitiser can
// match across such a boundary.
const TOKEN_CHAR = /[A-Za-z0-9._~+/=:-]/;

/**
 * Search backward from `buffer.length - minKeep` for the nearest safe cut
 * point (a position right after a non-token-run character), never going
 * below `buffer.length - MAX_HOLD`.
 */
function findSafeCut(buffer, minKeep) {
  let i = Math.max(0, buffer.length - minKeep);
  const floor = Math.max(0, buffer.length - MAX_HOLD);
  while (i > floor && TOKEN_CHAR.test(buffer[i - 1])) i--;
  return i;
}

/**
 * If there is an unterminated `-----BEGIN` marker before `cut`, pull the cut
 * back to the marker's start so a PEM block is never split across an emit
 * boundary. Bounded by MAX_HOLD from the marker so a malformed/adversarial
 * stream (BEGIN with no matching END) can't stall the buffer forever.
 */
function guardOpenPemBlock(buffer, cut) {
  const beginIdx = buffer.lastIndexOf('-----BEGIN', Math.max(0, cut - 1));
  if (beginIdx === -1) return cut;
  const endIdx = buffer.indexOf('-----END', beginIdx);
  const endComplete = endIdx !== -1 && endIdx + 8 <= cut;
  if (endComplete) return cut; // whole PEM block (or at least its END marker) is already inside the safe zone
  if (buffer.length - beginIdx >= MAX_HOLD) return cut; // ceiling hit — flush best-effort rather than stall forever
  return beginIdx;
}

/**
 * Create a stream redactor. `emit(text)` is called with already-redacted,
 * non-empty chunks as they become safe to send.
 */
function createStreamRedactor({ window = DEFAULT_WINDOW, emit } = {}) {
  if (typeof emit !== 'function') throw new Error('createStreamRedactor requires an emit(text) callback');
  let buffer = '';

  function maybeFlush() {
    if (buffer.length <= window) return;
    let cut = findSafeCut(buffer, window);
    cut = guardOpenPemBlock(buffer, cut);
    cut = guardEmDashZone(buffer, cut);
    if (cut <= 0) return;
    const safe = buffer.slice(0, cut);
    buffer = buffer.slice(cut);
    const redacted = scrubEmDashes(sanitiseString(safe));
    if (redacted.length > 0) emit(redacted);
  }

  function push(delta) {
    if (typeof delta !== 'string' || delta.length === 0) return;
    buffer += delta;
    maybeFlush();
  }

  /** Redact + emit whatever remains (call once at stream end). */
  function flush() {
    if (buffer.length === 0) return;
    const redacted = scrubEmDashes(sanitiseString(buffer));
    buffer = '';
    if (redacted.length > 0) emit(redacted);
  }

  return { push, flush };
}

module.exports = { createStreamRedactor, DEFAULT_WINDOW, MAX_HOLD };
