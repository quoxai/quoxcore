/**
 * QUOXCHAT-BRUTALOOP P-V — proactive engagement rules (Professional).
 *
 * Operator rules live in embed_config_json.proactive:
 *   [{ id?, match, delay_seconds, message, max_per_visitor }]
 * `match` is a URL path glob ('/pricing', '/docs/*', '*' = every page) or,
 * when wrapped in slashes ('/^\/blog\/\d+$/'), a regular expression. The
 * widget evaluates it against location.pathname. This module is the ONLY
 * place rules are validated; /config serves the sanitised output and never
 * the raw operator JSON.
 */

const MAX_RULES = 10;
const MAX_MATCH_LEN = 200;
const MAX_MESSAGE_LEN = 280;
const MIN_DELAY_S = 1;
const MAX_DELAY_S = 600;
const MAX_PER_VISITOR_CAP = 10;

function _isValidMatch(match) {
  if (typeof match !== 'string') return false;
  const m = match.trim();
  if (!m || m.length > MAX_MATCH_LEN) return false;
  if (m.length > 2 && m.startsWith('/') && m.endsWith('/')) {
    try { new RegExp(m.slice(1, -1)); return true; } catch { return false; }
  }
  return true;
}

function _stripMarkup(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns the clean rule or null when the row is invalid. */
function sanitiseProactiveRule(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  if (!_isValidMatch(raw.match)) return null;
  const message = typeof raw.message === 'string' ? _stripMarkup(raw.message).slice(0, MAX_MESSAGE_LEN) : '';
  if (!message) return null;
  const delay = Number(raw.delay_seconds);
  const perVisitor = Number(raw.max_per_visitor);
  return {
    id: `r${index}`,
    match: raw.match.trim(),
    delay_seconds: Number.isFinite(delay) ? Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(delay))) : 8,
    message,
    max_per_visitor: Number.isFinite(perVisitor) && perVisitor >= 1 ? Math.min(MAX_PER_VISITOR_CAP, Math.round(perVisitor)) : 1,
  };
}

function sanitiseProactiveRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const raw of rules.slice(0, MAX_RULES)) {
    const clean = sanitiseProactiveRule(raw, out.length);
    if (clean) out.push(clean);
  }
  return out;
}

module.exports = {
  sanitiseProactiveRules, sanitiseProactiveRule,
  MAX_RULES, MAX_MATCH_LEN, MAX_MESSAGE_LEN, MIN_DELAY_S, MAX_DELAY_S, MAX_PER_VISITOR_CAP,
};
