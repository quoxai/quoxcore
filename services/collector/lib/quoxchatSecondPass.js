'use strict';
/**
 * QC-BRUTALOOP-W15b: decide whether a second model pass (corrective
 * regeneration, re-verification, pinned price regeneration) may start.
 * p99 turn latency was 32.6s and 4 of ~80 turns hit the 45s watchdog's
 * "Sorry, that took longer than I expected". A second pass that cannot finish
 * before the watchdog is skipped and the verified first draft (with the
 * unsupported claims stripped) is served instead.
 */
const HARD_TURN_MS = 30000; // QC W17: matches routes/quoxchat hardTurnDeadlineMs()
const MIN_LEFT_MS = 8000;

function canStartSecondPass({ elapsedMs, hardMs = HARD_TURN_MS, minLeftMs = MIN_LEFT_MS, expectedMs = 0 } = {}) {
  const left = hardMs - (Number(elapsedMs) || 0);
  return left >= Math.max(minLeftMs, expectedMs);
}

const MONEY = /[£$€]\s?\d/;
const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'is', 'it', 'per', 'and', 'in', 'on', 'at', 'my', 'me', 'can', 'i', 'do', 'you', 'we', 'with', 'what', 'how', 'much', 'does', 'your', 'our', 'are', 'there', 'cost', 'price', 'fee', 'fees']);
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const toks = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);
const HISTORY_RE = /\bsuperseded\b|\barchiv(?:e|ed)\b|no longer current|out[- ]of[- ]date|history only/i;

/**
 * When a priced claim was stripped and a CURRENT chunk carries a figure for
 * the visitor's subject, regenerate once with that chunk pinned.
 * -> { regen, pin?, reason }
 */
function pickPricedRegen({ message, chunks, stripped, elapsedMs, hardMs, alreadyRegenerated = false, actionRan = false } = {}) {
  if (actionRan) return { regen: false, reason: 'action_ran' };
  if (alreadyRegenerated) return { regen: false, reason: 'already_regenerated' };
  const priced = (Array.isArray(stripped) ? stripped : []).some((x) => typeof x === 'string' && MONEY.test(x));
  if (!priced) return { regen: false, reason: 'not_priced' };
  const q = new Set(toks(message));
  let best = null;
  let bestN = 0;
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c || typeof c.text !== 'string' || c.history === true || HISTORY_RE.test(c.text.slice(0, 400)) || !MONEY.test(c.text)) continue;
    // Digits in the question ("2 year old") count; a shared noun is not enough alone.
    let n = 0;
    for (const t of new Set(toks(c.text))) if (q.has(t)) n++;
    if (n > bestN) { best = c; bestN = n; }
  }
  if (!best || bestN < 2) return { regen: false, reason: 'no_current_chunk' };
  if (!canStartSecondPass({ elapsedMs, hardMs })) return { regen: false, reason: 'no_budget' };
  return { regen: true, pin: best.text, reason: 'priced_strip_current_chunk' };
}

module.exports = { canStartSecondPass, pickPricedRegen, HARD_TURN_MS, MIN_LEFT_MS };
