/**
 * decisions: validation and shaping for `quox ask` decision requests.
 *
 * A decision request is ONE inbox item (kind 'question', payload.type 'decision') that a session or agent files
 * to put a fork in front of a human: who is asking (session + profile/agent), what, why, the options, the
 * recommendation and the expiry. It rides the existing Approvals inbox (openApprovals counts and lists it).
 * It is NOT an approval of an action: no step-up PIN unless the asker marks it high risk.
 */

export const MAX_EXPIRY_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_EXPIRY_MS = 24 * 3600 * 1000;
export const WARN_BEFORE_EXPIRY_MS = 15 * 60 * 1000;
const KEY_RE = /^[a-z0-9]{1,8}$/i;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const HIGH_RISK_NEEDS_JUSTIFY = 'High-risk asks need --justify "<2-3 plain lines the owner can judge>"';

/** Validate a create body. Returns { ok:true, payload, title, why, dueAt } or { ok:false, error }. */
export function buildDecision(body = {}, { now = Date.now() } = {}) {
  const title = clip(body.title, 200);
  if (!title) return { ok: false, error: 'title is required (what are you asking?)' };
  const session = clip(body.session, 60);
  if (!session) return { ok: false, error: 'session is required (which session is asking?)' };
  const raw = Array.isArray(body.options) ? body.options : [];
  if (raw.length < 2 || raw.length > 9) return { ok: false, error: 'options: give between 2 and 9, e.g. "a: Ship now|b: Wait"' };
  const options = [];
  for (const o of raw) {
    const key = clip(o?.key, 8).toLowerCase();
    const label = clip(o?.label, 120) || key;
    if (!KEY_RE.test(key)) return { ok: false, error: `option key "${clip(o?.key, 12)}" must be 1 to 8 letters or digits` };
    if (options.some((x) => x.key === key)) return { ok: false, error: `option key "${key}" is repeated` };
    options.push({ key, label });
  }
  const has = (k) => options.some((o) => o.key === k);
  const dflt = body.default ? clip(body.default, 8).toLowerCase() : null;
  const rec = body.recommend ? clip(body.recommend, 8).toLowerCase() : null;
  if (dflt && !has(dflt)) return { ok: false, error: `default "${dflt}" is not one of the options` };
  if (rec && !has(rec)) return { ok: false, error: `recommend "${rec}" is not one of the options` };
  let ms = DEFAULT_EXPIRY_MS;
  if (body.expires_in_seconds != null) {
    const s = Number(body.expires_in_seconds);
    if (!Number.isFinite(s) || s < 10) return { ok: false, error: 'expiry must be at least 10 seconds' };
    ms = Math.min(s * 1000, MAX_EXPIRY_MS);
  }
  const dueAt = new Date(now + ms).toISOString();
  const why = clip(body.why, 1000);
  // QUOXON 2026-10-17 (owner: "u need to give me justification in future"): a high-risk ask must say, in plain words,
  // why it is safe; without it the card can only default to No.
  if (body.high_risk === true && !clip(body.justification, 1000)) return { ok: false, error: HIGH_RISK_NEEDS_JUSTIFY };
  const payload = {
    type: 'decision',
    session,
    profile: clip(body.profile, 60) || null,
    agent: clip(body.agent, 60) || null,
    slot: clip(body.slot, 60) || null,
    why: why || null,
    // QUOXON 2026-10-17: the plain justification a loosening card shows on its JUSTIFY line (else it defaults to No)
    justification: clip(body.justification, 1000) || null,
    options,
    default: dflt,
    recommend: rec,
    expires_at: dueAt,
    high_risk: body.high_risk === true,
    yn: options.length === 2 && has('y') && has('n'),
  };
  return { ok: true, payload, title, why, dueAt };
}

/**
 * Turn a respond request into a decision outcome.
 * answer {option} | approve (y/n decisions: y) | deny/reject (decline with a reason). Anything else is refused.
 * Returns { ok:true, action, option|null } or { ok:false, error }.
 */
export function resolveDecisionResponse(payload, { action, option, data } = {}) {
  const act = String(action || '').trim().toLowerCase();
  const keys = (payload.options || []).map((o) => o.key);
  if (['deny', 'denied', 'reject', 'rejected'].includes(act)) return { ok: true, action: 'deny', option: null };
  if (act === 'approve' || act === 'approved') {
    if (!keys.includes('y')) return { ok: false, error: 'this decision is not yes/no; answer with one of: ' + keys.join(', ') };
    return { ok: true, action: 'answer', option: 'y' };
  }
  if (act === 'answer') {
    const k = String(option ?? data?.option ?? '').trim().toLowerCase();
    if (!keys.includes(k)) return { ok: false, error: `option "${k}" is not one of: ${keys.join(', ')}` };
    return { ok: true, action: 'answer', option: k };
  }
  return { ok: false, error: 'a decision takes action answer (with option), approve (y/n only) or deny' };
}

/** The asker-facing view of a decision item row. */
export function decisionView(row, now = Date.now()) {
  let p = {}; let r = null;
  try { p = JSON.parse(row.payload_json || '{}'); } catch { /* shown as pending with no detail */ }
  try { r = row.response_json ? JSON.parse(row.response_json) : null; } catch { r = null; }
  const active = ['open', 'in_progress', 'waiting'].includes(row.status);
  let state = 'pending';
  if (row.status === 'expired') state = 'expired';
  else if (row.status === 'cancelled') state = 'cancelled';
  else if (!active) state = r?.action === 'deny' ? 'denied' : 'answered';
  const due = row.due_at ? Date.parse(row.due_at) : null;
  return {
    id: row.id,
    state,
    title: row.title,
    session: p.session || null,
    options: p.options || [],
    default: p.default || null,
    recommend: p.recommend || null,
    expires_at: row.due_at || null,
    expires_soon: Boolean(active && due && due - now <= WARN_BEFORE_EXPIRY_MS),
    answer: r && !active && state !== 'expired' ? {
      option: r.option || null,
      note: r.comment || null,
      action: r.action || null,
      by: r.responded_by_name || r.responded_by || null,
      at: r.responded_at || null,
    } : null,
  };
}

/**
 * DECISION-LABELS: a model-facing brief of a pending decision, every option with its LABEL (an option filed with no
 * label is listed under `unlabelled` so nobody invents a meaning). Mirrors collector/lib/decisionBrief.js.
 */
export function decisionBrief(p) {
  if (!p || p.type !== 'decision' || !Array.isArray(p.options)) return null;
  const options = []; const unlabelled = [];
  for (const o of p.options) {
    const key = String(o?.key ?? '').trim();
    if (!key) continue;
    const label = String(o?.label ?? '').trim();
    if (!label || label.toLowerCase() === key.toLowerCase()) { unlabelled.push(key); options.push({ key, label: null }); } else options.push({ key, label });
  }
  const labelOf = (k) => (k ? (options.find((o) => o.key === k)?.label || null) : null);
  const out = {
    session: p.session || null, why: p.why || null, justification: p.justification || null, options,
    recommend: p.recommend || null, recommend_label: labelOf(p.recommend),
    default: p.default || null, default_label: labelOf(p.default), high_risk: p.high_risk === true,
    instruction: 'Say each option in words with the key in brackets, e.g. "keep them visible as not_testable (a)". Name the question by its title, never by a position or number (your order is not the /answer numbering of the terminal). Never recommend a bare letter.',
  };
  if (unlabelled.length) { out.unlabelled = unlabelled; out.note = `options ${unlabelled.join('/')} have no labels: see the ask. Do not invent what they mean; say the asker gave no label for them.`; }
  return out;
}
