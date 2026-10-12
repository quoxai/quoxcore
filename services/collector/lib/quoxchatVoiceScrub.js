/**
 * QuoxChat Voice Scrub — QCPRO house-voice enforcement (server-side)
 *
 * The house voice bans em dashes in prose. The persona prompt asks the model
 * not to emit them, but nothing enforced it in the reply path and an owner
 * transcript showed one reach a visitor. This module rewrites em dashes to
 * house-voice punctuation (commas, bullets, or plain removal) on model
 * output only. It is wired at the two reply chokepoints: the assembled
 * responseText in routes/quoxchat.js and the stream redactor's emit
 * boundary, so streamed tokens and the final/persisted text agree.
 *
 * Scope, deliberately narrow:
 *   - Em dash (U+2014) only. Double hyphens are CLI flags in support
 *     answers (--apply); en dashes are legitimate ranges (9–5). Neither is
 *     touched.
 *   - Code fences are NOT exempted: an em dash has no syntactic meaning in
 *     anything we ship examples for, and inside a fence it is the same
 *     voice giveaway. Documented residual: a copy-paste literal containing
 *     an em dash would be rewritten.
 *
 * Rewrite rules, in application order (all whitespace classes are space/tab
 * only so a dash at a line break never joins two lines):
 *   1. line-leading "— item"        -> "- item"   (markdown bullet)
 *   2. trailing "text —" at EOM     -> "text"
 *   3. "works —, mostly"            -> "works, mostly"  (dash before punct)
 *   4. "features: — none"           -> "features: none" (dash after punct)
 *   5. "fast — and" / "fast—and"    -> "fast, and"      (inter-word)
 *   6. anything left                -> single space
 * The output never contains U+2014, which also makes the scrub idempotent.
 */

'use strict';

const EM = '—';

function scrubEmDashes(text) {
  if (typeof text !== 'string' || text.indexOf(EM) === -1) return text;
  let out = text;
  // 1. line-leading bullet
  out = out.replace(/(^|\n)([ \t]*)—+[ \t]+/g, '$1$2- ');
  // 2. trailing dash at end of message
  out = out.replace(/[ \t]*—+[ \t]*$/, '');
  // 3. dash butting against following punctuation
  out = out.replace(/[ \t]*—+[ \t]*(?=[,.;:!?])/g, '');
  // 4. dash following punctuation
  out = out.replace(/([,;:.!?])[ \t]*—+[ \t]*/g, '$1 ');
  // 5. inter-word dash becomes a comma
  out = out.replace(/([^\s—])[ \t]*—+[ \t]*(?=[^\s—])/g, '$1, ');
  // 6. leftovers (line-break-adjacent, message-leading without a space)
  out = out.replace(/[ \t]*—+[ \t]*/g, ' ');
  return out;
}

/**
 * Stream-boundary guard for quoxchatStreamRedactor. Given the redactor's
 * buffer and a proposed cut point, pull the cut back so an em dash zone
 * (optional spaces + dashes + optional spaces) is never split across an
 * emit boundary, AND the word immediately before the zone stays with the
 * retained side. That way the inter-word rewrite always sees both sides of
 * the dash inside a single chunk, and a chunk can only *start* with an em
 * dash when it genuinely sits at a line start (where the bullet rule is the
 * correct rewrite anyway).
 */
function guardEmDashZone(buffer, cut) {
  if (cut <= 0 || cut >= buffer.length) return cut;
  const isSp = (c) => c === ' ' || c === '\t';
  // Does the retained side start with (spaces +) an em dash?
  let f = cut;
  while (f < buffer.length && isSp(buffer[f])) f++;
  const forwardDash = buffer[f] === EM;
  // Does the emitted side end with an em dash (+ spaces)?
  let b = cut;
  while (b > 0 && isSp(buffer[b - 1])) b--;
  const backwardDash = b > 0 && buffer[b - 1] === EM;
  if (!forwardDash && !backwardDash) return cut;
  // Pull back past the zone and the word preceding it.
  let i = b;
  while (i > 0 && buffer[i - 1] === EM) i--;
  while (i > 0 && isSp(buffer[i - 1])) i--;
  while (i > 0 && !/\s/.test(buffer[i - 1]) && buffer[i - 1] !== EM) i--;
  return i;
}

module.exports = { scrubEmDashes, guardEmDashZone };
