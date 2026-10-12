/**
 * Repo-scoped credential selection.
 *
 * A vault credential is stored per ORG, and until now `github` resolution took
 * `getDefaultCredential(orgId, 'github')` — one token for every repository the
 * org's agents ever touch. That is wrong the moment an org holds more than one
 * PAT, which is the normal case: a fine-grained PAT for the website, another
 * for the product repos, a customer's PAT for the customer's repo. GRIPE routes
 * a complaint to one of seven repos by keyword and then reached for the same
 * token regardless, so a website gripe was filed with a token that cannot see
 * the website (owner-reported 2026-08-23, quoxai/quox#481).
 *
 * A credential declares which repositories it covers in
 * `metadata_json.repos`, an array of patterns:
 *
 *   "quoxai/quoxwebsite"   exact repo
 *   "quoxai/*"             any repo under an owner
 *   "*"                    anything (an explicit catch-all)
 *
 * Selection is most-specific-wins, so a credential naming the exact repo beats
 * one naming the owner, which beats a catch-all. A credential with no patterns
 * declares nothing and can only be reached through the org default, which keeps
 * every existing org working unchanged: today nobody has patterns, so today
 * every lookup falls through to the default exactly as before.
 *
 * Deliberately NOT cross-org. Resolving org A's request with org B's stored
 * credential would cross a tenant boundary inside a code path an agent can
 * reach with no human present. To gripe about another org's repo, put a
 * credential for that repo in the org you are griping FROM: that is a human
 * placing a secret where they have admin, which is a decision with an owner,
 * rather than a silent read across the boundary.
 */

const EXACT = 3;
const OWNER_WILDCARD = 2;
const CATCH_ALL = 1;
const NO_MATCH = 0;

/**
 * Parse the repo patterns off a credential row.
 * Tolerates absent, malformed or non-array metadata: a credential that cannot
 * state its scope simply has none, rather than throwing on the resolve path.
 *
 * @param {object} row credential row with metadata_json
 * @returns {string[]}
 */
export function readRepoPatterns(row) {
  if (!row) return [];
  const raw = row.metadata_json;
  if (!raw) return [];
  let meta;
  try {
    meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_err) {
    return [];
  }
  const repos = meta && meta.repos;
  if (!Array.isArray(repos)) return [];
  return repos.filter((p) => typeof p === 'string' && p.trim() !== '').map((p) => p.trim());
}

/**
 * Score one pattern against a repo. Case-insensitive: GitHub treats
 * owner/name case-insensitively and a user typing `QuoxAI/quox` must not
 * silently fall through to the wrong token.
 *
 * @param {string} pattern
 * @param {string} repo full "owner/name"
 * @returns {number} EXACT | OWNER_WILDCARD | CATCH_ALL | NO_MATCH
 */
export function scorePattern(pattern, repo) {
  if (!pattern || !repo) return NO_MATCH;
  const p = pattern.toLowerCase();
  const r = repo.toLowerCase();

  if (p === '*' || p === '*/*') return CATCH_ALL;
  if (p === r) return EXACT;

  if (p.endsWith('/*')) {
    const owner = p.slice(0, -2);
    // Match on the OWNER segment only, never a bare prefix: "quoxai/*" must
    // not match "quoxai-internal/thing".
    const slash = r.indexOf('/');
    if (slash > 0 && r.slice(0, slash) === owner) return OWNER_WILDCARD;
  }

  return NO_MATCH;
}

/**
 * Best score any of a credential's patterns achieves for this repo.
 *
 * @param {object} row credential row
 * @param {string} repo
 * @returns {number}
 */
export function scoreCredential(row, repo) {
  let best = NO_MATCH;
  for (const pattern of readRepoPatterns(row)) {
    const score = scorePattern(pattern, repo);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Choose the credential that should serve a request for `repo`.
 *
 * @param {object[]} rows all of the org's credentials for one integration type
 * @param {string} repo   "owner/name", or falsy when the caller named no repo
 * @returns {{credential: object|null, reason: string, score: number}}
 *   reason is one of:
 *     'repo-match'   a declared pattern matched (score says how specific)
 *     'org-default'  no pattern matched; fell back to the org default
 *     'none'         the org has no usable credential at all
 *
 * The reason is part of the return value on purpose. A fallback that looks
 * identical to a match is how the wrong token gets used silently; callers log
 * it, and the tool error names it when the call then fails.
 */
export function selectCredentialForRepo(rows, repo) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return { credential: null, reason: 'none', score: NO_MATCH };

  if (repo) {
    let best = null;
    let bestScore = NO_MATCH;
    for (const row of list) {
      const score = scoreCredential(row, repo);
      if (score <= NO_MATCH) continue;
      if (score > bestScore) {
        best = row;
        bestScore = score;
        continue;
      }
      if (score === bestScore && best) {
        // Same specificity: prefer the org default, then the lower id, so the
        // choice is stable across processes rather than dependent on row order.
        const bestIsDefault = !!best.is_default;
        const rowIsDefault = !!row.is_default;
        if (rowIsDefault && !bestIsDefault) best = row;
        else if (rowIsDefault === bestIsDefault && String(row.id) < String(best.id)) best = row;
      }
    }
    if (best) return { credential: best, reason: 'repo-match', score: bestScore };
  }

  const fallback = list.find((r) => r.is_default) || null;
  if (fallback) return { credential: fallback, reason: 'org-default', score: NO_MATCH };
  return { credential: null, reason: 'none', score: NO_MATCH };
}

export const SCORES = { EXACT, OWNER_WILDCARD, CATCH_ALL, NO_MATCH };
