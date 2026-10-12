/**
 * feedExcludeRegistry.js — The Feed's hard EXCLUDE gate for the generic
 * db-source adapter (L1, docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md
 * "The 'whole database' idea — realistic, but GOVERNED").
 *
 * The plan is explicit: a generic db-source adapter is fine because every
 * high-value store already shares Qortex's shape, but it must NEVER become
 * a "point at any table" toggle — the same databases that hold Tier-1/2
 * knowledge also hold secrets/credentials, billing/usage counters, and
 * cross-tenant marketplace rows. This module is the fail-fast floor: every
 * feedDbAdapters.js spec is run through assertAdapterSafe() at module load,
 * so a spec that accidentally names an excluded table or column throws
 * immediately at boot rather than silently ingesting something ungoverned.
 *
 * Deliberately over-inclusive (substring/regex matching, case-insensitive)
 * — a false-positive block on a legitimate table just means a human has to
 * rename a column or add a narrower spec; a false-negative here means a
 * secret leaks into an org's Qortex vault. Zero tolerance, per this repo's
 * data-persistence/security rules.
 */

'use strict';

// Secrets/credentials/keys — anything whose VALUE must never leave the
// store it lives in, regardless of org scoping.
const SECRET_WORDS = [
  'secret',
  'credential',
  'api_key',
  'apikey',
  'token',
  'signing_key',
  'password',
  'session_state',
];

// Billing/usage counters — not knowledge, and often cross-org-sensitive
// (rate limits, quotas) in ways that don't belong in a user-facing brain.
const BILLING_WORDS = [
  'usage',
  'quota',
  'rate_limit',
  'listing_stats',
  'update_',
];

// Cross-tenant marketplace — rows that span organizations by design (a
// listing's seller is a DIFFERENT org than a buyer's), so no single
// orgCol scoping can make these safe for a per-org adapter.
const MARKETPLACE_WORDS = [
  'listing',
  'marketplace',
  'seller',
];

function toPatterns(words) {
  return words.map((w) => new RegExp(w, 'i'));
}

// Exported separately (table vs column) per the L1 spec, though in
// practice both should be checked against the full combined list — a
// column can be named like a table-ish word (a "secrets" column) and vice
// versa. See ALL_PATTERNS / assertAdapterSafe below.
const EXCLUDE_TABLE_PATTERNS = toPatterns([...SECRET_WORDS, ...BILLING_WORDS, ...MARKETPLACE_WORDS]);
const EXCLUDE_COLUMN_PATTERNS = toPatterns([...SECRET_WORDS, ...BILLING_WORDS, ...MARKETPLACE_WORDS]);

const ALL_PATTERNS = [...EXCLUDE_TABLE_PATTERNS, ...EXCLUDE_COLUMN_PATTERNS];

function matchesAny(value, patterns) {
  const str = String(value == null ? '' : value);
  return patterns.some((p) => p.test(str));
}

/**
 * Collects every column-ish field a db-source adapter spec declares
 * (org/user scoping columns, text columns, title/updated/id columns, and
 * redact columns) into a flat, de-duplicated list for pattern checking.
 * `where` clauses are NOT included here — they're free-form SQL, not a
 * column identifier, and are the adapter author's responsibility to keep
 * narrow (see feedDbAdapters.js's aocl_policy spec for the pattern).
 */
function collectSpecColumns(spec) {
  const cols = [
    spec?.orgCol,
    spec?.userCol,
    spec?.titleCol,
    spec?.updatedCol,
    spec?.idCol,
    ...(Array.isArray(spec?.textCols) ? spec.textCols : []),
    ...(Array.isArray(spec?.redactCols) ? spec.redactCols : []),
  ].filter(Boolean);
  return [...new Set(cols)];
}

/**
 * Throws if `spec.table` OR any column it declares matches an exclude
 * pattern (secrets/credentials/keys, billing/usage counters, cross-tenant
 * marketplace). Call this at module load for every registered adapter
 * spec — a throw here must fail the collector's boot, not degrade
 * silently, since a passing spec is what makes an adapter eligible to run
 * at all.
 *
 * @param {{sourceType?: string, table: string, orgCol?: string, userCol?: string|null,
 *   textCols?: string[], titleCol?: string, updatedCol?: string, idCol?: string,
 *   redactCols?: string[]}} spec
 * @returns {true}
 */
function assertAdapterSafe(spec) {
  const label = spec?.sourceType || spec?.table || '(unnamed adapter)';

  if (spec?.table && matchesAny(spec.table, ALL_PATTERNS)) {
    throw new Error(`[FeedExcludeRegistry] adapter "${label}": table "${spec.table}" matches an EXCLUDED pattern — refusing to register`);
  }

  for (const col of collectSpecColumns(spec)) {
    if (matchesAny(col, ALL_PATTERNS)) {
      throw new Error(`[FeedExcludeRegistry] adapter "${label}": column "${col}" matches an EXCLUDED pattern — refusing to register`);
    }
  }

  return true;
}

module.exports = {
  EXCLUDE_TABLE_PATTERNS,
  EXCLUDE_COLUMN_PATTERNS,
  assertAdapterSafe,
  collectSpecColumns,
  _matchesAny: matchesAny,
};
