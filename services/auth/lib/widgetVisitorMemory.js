/**
 * QCX-3.2 — Widget visitor memory helpers.
 *
 * Pure module — merges identify-attrs under an allowlist (PII hygiene) and
 * builds the "returning visitor" preamble the collector injects into the
 * LLM system prompt so a returning visitor gets a personalised greeting
 * without re-asking questions they already answered.
 *
 * Intentionally minimal: first_seen, last_seen, conversation_count,
 * identified_attrs. Topic tracking + style profile are follow-on — this
 * module is the foundation.
 */

export const ATTR_ALLOWLIST = new Set([
  'email',
  // QUOXCHAT-EMAIL D2 — provenance of the email above: 'identify' (host-site
  // HMAC vouched), 'chat' (typed in the conversation), 'declared'
  // (identify() without a hash). Computed server-side in visitors/upsert;
  // caller-supplied values are stripped there before the merge.
  'email_source',
  'name',
  'first_name',
  'last_name',
  'company',
  'plan',
  'role',
  'phone',
  'locale',
  'timezone',
  'user_id',       // customer's own stable id for the visitor
  'external_id',
]);

const MAX_STRING_LEN = 200;

function _sanitiseValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
}

/**
 * Merges freshly-supplied identify-attrs over an existing record. Drops
 * any keys not in ATTR_ALLOWLIST (so a visitor calling
 * QuoxChat.identify({password: 'leak'}) can't populate our DB).
 */
export function mergeIdentifiedAttrs(existing, incoming) {
  const out = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (ATTR_ALLOWLIST.has(k)) {
        const s = _sanitiseValue(v);
        if (s !== undefined) out[k] = s;
      }
    }
  }
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [k, v] of Object.entries(incoming)) {
      if (ATTR_ALLOWLIST.has(k)) {
        const s = _sanitiseValue(v);
        if (s !== undefined) out[k] = s;
      }
    }
  }
  return out;
}

/**
 * Builds a short "returning visitor" preamble the collector injects into
 * the LLM system prompt. Empty string for first-time visitors so a fresh
 * conversation starts neutrally.
 *
 * Display rules:
 *   - name beats email (less intrusive — don't read out their email).
 *   - Mentions the prior conversation count to hint at continuity.
 *   - Doesn't include internal ids (visitor_id, user_id) — those are
 *     operational, not conversational.
 *   - QCL-IDENTITY P1: record.verified (truthy) means the collector
 *     HMAC-verified the visitor's user_hash against the widget's
 *     identity_secret — phrase this as authoritative ("verified as").
 *     Identified-but-unverified stays "signed in as" (self-declared,
 *     forgeable — a visitor could call identify({email:'ceo@corp.com'})
 *     with no proof).
 */
export function summariseVisitor(record) {
  if (!record || typeof record !== 'object') return '';
  const count = Number(record.conversation_count) || 0;
  const attrs = (record.identified_attrs && typeof record.identified_attrs === 'object') ? record.identified_attrs : {};
  const name = attrs.name || [attrs.first_name, attrs.last_name].filter(Boolean).join(' ') || null;
  const identity = name || attrs.email || null;
  const returning = count > 1;
  const isVerified = !!record.verified;

  // Identity is surfaced as soon as the host has identified the visitor (via
  // QuoxChat.identify) — on the FIRST conversation, not only on return — so the
  // bot knows who it is talking to when they are logged in.
  if (identity && returning) {
    return isVerified
      ? `The visitor is verified as ${identity}. This is a returning visitor (${count} previous conversations) — greet them by name if appropriate and continue where you left off.`
      : `The visitor is signed in as ${identity}. This is a returning visitor (${count} previous conversations) — greet them by name if appropriate and continue where you left off.`;
  }
  if (identity) {
    return isVerified
      ? `The visitor is verified as ${identity} — greet them by name if appropriate.`
      : `The visitor is signed in as ${identity} — greet them by name if appropriate.`;
  }
  if (returning) {
    return `This is a returning visitor (${count} previous conversations) — be helpful and continue where you left off.`;
  }
  return '';
}
