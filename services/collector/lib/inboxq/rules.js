'use strict';

/**
 * InboxQ rules engine — pure match semantics, the owner's "spamfilter-blocker"
 * feature: user-defined rules that auto-sort mail on every sync.
 *
 * Shared by:
 *   - syncWorker.js  — apply-on-sync, evaluated against each freshly ingested
 *                       message BEFORE it lands in a zone.
 *   - api.js         — hPreviewRule (dry-run over stored mail) and
 *                       hApplyRules (a user-triggered backlog pass).
 *
 * Deterministic + cheap by design: plain string comparisons only, no LLM, no
 * IMAP, no store access. Pure functions over plain message-shaped objects
 * ({fromAddr, fromName, subject}) so a rule error can never reach outside
 * this module and a match decision is trivially unit-testable without a DB.
 *
 * MATCH SEMANTICS (case-insensitive; documented per repo CLAUDE.md — every
 * match type's exact contract is written down, not left to be inferred):
 *   from    — the message's from_addr, normalized, EQUALS match_value.
 *   domain  — the message's from_addr domain EQUALS match_value
 *             (e.g. matchValue 'spamdomain.com' matches
 *             'anyone@spamdomain.com', never a subdomain).
 *   tld     — the message's from_addr domain ENDS WITH '.' + match_value
 *             (a bare tld, no leading dot — e.g. matchValue 'guru' matches
 *             'x@offers.guru' and 'x@sub.offers.guru').
 *   name    — the message's from_name CONTAINS match_value (substring).
 *   subject — the message's subject CONTAINS match_value (substring).
 * An unknown match_type never matches (fail closed).
 */

const MATCH_TYPES = ['from', 'domain', 'tld', 'name', 'subject'];
const ACTIONS = ['move', 'screen', 'block'];

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

function domainOf(addr) {
  const a = norm(addr);
  const at = a.indexOf('@');
  return at > 0 ? a.slice(at + 1) : '';
}

/** True if `rule` ({matchType, matchValue}) matches `msg` ({fromAddr, fromName, subject}). */
function matchRule(rule, msg) {
  if (!rule || !msg) return false;
  const value = norm(rule.matchValue);
  if (!value) return false;
  switch (rule.matchType) {
    case 'from':
      return norm(msg.fromAddr) === value;
    case 'domain':
      return domainOf(msg.fromAddr) === value.replace(/^@/, '');
    case 'tld': {
      const tld = value.replace(/^\./, '');
      const domain = domainOf(msg.fromAddr);
      return Boolean(domain) && Boolean(tld) && domain.endsWith(`.${tld}`);
    }
    case 'name':
      return norm(msg.fromName).includes(value);
    case 'subject':
      return norm(msg.subject).includes(value);
    default:
      return false; // unknown match_type: fail closed, never matches
  }
}

/**
 * First-match-wins scan over `rules` against `msg`. Callers are responsible
 * for ordering `rules` highest-priority-first (store.listRules already
 * orders this way); a disabled rule is skipped defensively even if the
 * caller forgot to pre-filter. Returns the matching rule object or null.
 */
function findMatchingRule(rules, msg) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (matchRule(rule, msg)) return rule;
  }
  return null;
}

module.exports = { MATCH_TYPES, ACTIONS, matchRule, findMatchingRule };
