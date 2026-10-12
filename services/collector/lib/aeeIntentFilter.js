'use strict';

// INCIDENT quox#700: /aee/query built a contains-style LIKE (leading wildcard) for every caller, a
// leading-wildcard pattern no index can serve, so the footer status probe
// (?intent=aocl.) walked the whole envelopes table every poll. Namespace-shaped
// intents ("aocl.", "quox.dev.supervisor.set") are now matched as a PREFIX with
// a half-open range (intent >= lo AND intent < hi) that idx_envelopes_org_intent
// serves directly. Anything else keeps the historical CONTAINS semantics.
// Prefix match is case-sensitive (range compare); intents are lowercase dotted.

const NAMESPACE_INTENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*)+$/;

function buildIntentFilter(intent) {
  if (!intent) return { mode: 'none', like: null, lo: null, hi: null };
  const s = String(intent);
  if (NAMESPACE_INTENT.test(s)) {
    const last = s.charCodeAt(s.length - 1);
    return { mode: 'prefix', like: null, lo: s, hi: s.slice(0, -1) + String.fromCharCode(last + 1) };
  }
  return { mode: 'contains', like: `%${s}%`, lo: null, hi: null };
}

module.exports = { buildIntentFilter };
