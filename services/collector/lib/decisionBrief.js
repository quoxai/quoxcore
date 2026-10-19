'use strict';
/**
 * DECISION-LABELS (2026-10-17): a pending decision (`quox ask`, inbox payload.type 'decision') described to a model.
 * Live 2026-10-17 07:01 UTC chat said "I'd pick a for the first, b for the second" and the owner answered
 * "youre just shouting letters". Every option now travels with its LABEL; an option filed with no label
 * (label equals key) is reported as unlabelled so the model never invents a meaning for it.
 */

function parsePayload(p) {
  if (p && typeof p === 'object') return p;
  try { return JSON.parse(String(p || '{}')); } catch { return {}; }
}

/** -> null when the payload is not a decision, else { session, why, options:[{key,label}], unlabelled:[keys], recommend, recommend_label, default, instruction }. */
function decisionBrief(payloadIn) {
  const p = parsePayload(payloadIn);
  if (!p || p.type !== 'decision' || !Array.isArray(p.options)) return null;
  const options = [];
  const unlabelled = [];
  for (const o of p.options) {
    const key = String(o?.key ?? '').trim();
    if (!key) continue;
    const label = String(o?.label ?? '').trim();
    if (!label || label.toLowerCase() === key.toLowerCase()) { unlabelled.push(key); options.push({ key, label: null }); }
    else options.push({ key, label });
  }
  const labelOf = (k) => (k ? (options.find((o) => o.key === k)?.label || null) : null);
  const out = {
    session: p.session || null,
    why: p.why || null,
    options,
    recommend: p.recommend || null,
    recommend_label: labelOf(p.recommend),
    default: p.default || null,
    default_label: labelOf(p.default),
    high_risk: p.high_risk === true,
    instruction: 'Say each option in words with the key in brackets, e.g. "keep them visible as not_testable (a)". Name the question by its title, never by a position or number (your order is not the /answer numbering of the terminal). Never recommend a bare letter.',
  };
  if (unlabelled.length) out.unlabelled = unlabelled;
  if (unlabelled.length) out.note = `options ${unlabelled.join('/')} have no labels: see the ask. Do not invent what they mean; say the asker gave no label for them.`;
  return out;
}

module.exports = { decisionBrief };
