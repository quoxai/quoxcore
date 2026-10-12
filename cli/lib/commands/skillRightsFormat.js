/**
 * SKILLRIGHTS #478 Phase 11 — shared presentation helpers for SkillRights
 * licence identifiers in CLI surfaces. One place, so every verb renders the
 * same labels and accepts the same filter vocabulary.
 */

const SHORT_LABELS = {
  'LicenseRef-SkillRights-Open-1.0': 'Open 1.0',
  'LicenseRef-SkillRights-NoTrain-1.0': 'NoTrain 1.0',
  'LicenseRef-SkillRights-Reserved-1.0': 'Reserved 1.0',
};

const FILTER_ALIASES = {
  open: 'LicenseRef-SkillRights-Open-',
  notrain: 'LicenseRef-SkillRights-NoTrain-',
  reserved: 'LicenseRef-SkillRights-Reserved-',
};

/** Human label for a licence identifier; null/undefined -> '(undeclared)';
 *  unknown identifiers pass through untouched (never mislabel). */
export function shortLicenceLabel(id) {
  if (!id) return '(undeclared)';
  return SHORT_LABELS[id] || id;
}

/**
 * Does a licence identifier match a user-supplied filter?
 * Accepted filters (case-insensitive): open | notrain | reserved |
 * undeclared, or any full identifier for an exact match. A null filter
 * matches everything.
 */
export function matchesLicenceFilter(license, filter) {
  if (!filter) return true;
  const f = String(filter).toLowerCase();
  if (f === 'undeclared' || f === 'none') return !license;
  if (FILTER_ALIASES[f]) return typeof license === 'string' && license.startsWith(FILTER_ALIASES[f]);
  return license === filter;
}
