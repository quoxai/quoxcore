'use strict';
/**
 * Classify how a one-shot Claude CLI dispatch ended on /chat/stream.
 * A kill caused by the turn's own interrupt (SIGTERM, exit 143, thrown or
 * returned as an error) is 'interrupted', never 'failed'. Genuine crashes
 * (no interrupt) stay 'failed'. A client disconnect is not an interrupt.
 */
function classifyCliEnd({ interrupted, aborted, thrown, result }) {
  if (interrupted && !aborted) return 'interrupted';
  if (thrown) return 'failed';
  if (!result || result.outcome !== 'success') return 'failed';
  return 'ok';
}

/**
 * quox#1044 (WORKER1 CLI_1792137143765_3szs6r): a failed CLI end (timeout kill, exit 143, a stop for
 * a late specialist answer) after the user was already shown an answer is NOT a bare error. The turn
 * finishes with what was shown; an honest note says the CLI stopped early, unless it was stopped
 * because the specialist's full answer arrived (lateEnded), which is a normal finish.
 * @returns {{salvaged:false}|{salvaged:true, text:string, note:string}}
 */
// The Claude CLI streams its own quota stop as text ("You've hit your weekly limit · resets ...",
// or the older "Claude AI usage limit reached|<epoch>"). When that notice is ALL that was shown
// it is not an answer: the turn must end as an error so the user and the proof engine see a
// provider stop, not a reply (2026-10-16, a dev weekly limit recorded as a product fail).
const LIMIT_NOTICE = /^(?:you(?:'|\u2019|\u2018)?ve|you have) (?:hit|reached) your [\w -]{0,20}limit\b[^\n]{0,80}$|^claude ai usage limit reached\b[^\n]{0,40}$/i;
function isLimitNotice(text) {
  return LIMIT_NOTICE.test(String(text || '').trim());
}

function salvageCliEnd({ end, shownText, lateEnded = false, reason = '' } = {}) {
  if (end !== 'failed') return { salvaged: false };
  // A provider refusal is never salvaged (a65fc4729). A LIMIT stop is different (SITE-CLI ruling 2026-10-19): a real
  // partial answer it cut off is salvaged with an honest note (0f0d15155); its own limit line alone is never an answer.
  const refusal = require('./providerRefusal.js').providerRefusalFrom(reason);
  const text = typeof shownText === 'string' ? shownText : '';
  if (refusal && (refusal.code !== 'provider_limit' || !text.trim() || isLimitNotice(text))) return { salvaged: false, refusal };
  if (!text.trim()) return { salvaged: false };
  if (isLimitNotice(text)) return { salvaged: false };
  if (refusal) {
    const why = String(refusal.message || reason || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return { salvaged: true, text, note: `\n\n(The provider's usage limit stopped this answer before it finished: ${why} The answer above is what was produced up to then; it may be incomplete.)` };
  }
  if (lateEnded) return { salvaged: true, text, note: '' };
  const why = String(reason || 'it was stopped').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { salvaged: true, text, note: `\n\n(The Claude CLI stopped before it finished: ${why}. The answer above is what was produced up to then; it may be incomplete.)` };
}

module.exports = { classifyCliEnd, salvageCliEnd, isLimitNotice };
