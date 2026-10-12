/**
 * QSKL-14a Slice 3 — Policy-satisfies diff helper
 *
 * Compares two `policySatisfies` arrays with normalisation:
 *   - coerce null/undefined/non-array inputs to []
 *   - trim whitespace + lowercase each element
 *   - sort + deduplicate
 *
 * Only then are the two arrays compared element-by-element.
 * This means ['A','B'] vs ['b','A','A'] is NOT a change, but
 * ['A'] vs ['A','C'] IS a change.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolicyDiff {
  changed: boolean;
  /** Normalised form of the before array (sorted, deduped, lowercased). */
  old_claims: string[];
  /** Normalised form of the after array (sorted, deduped, lowercased). */
  new_claims: string[];
  /** Claims present in new_claims but not in old_claims. */
  added: string[];
  /** Claims present in old_claims but not in new_claims. */
  removed: string[];
  /** Human-readable summary, e.g. "added [pci-dss-4.0]; removed [iso-27001]". Empty when unchanged. */
  diff_summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce an unknown value to a normalised string array:
 * trim, lowercase, sort, deduplicate.
 */
function normalise(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (norm === '') continue;
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
    }
  }
  result.sort();
  return result;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Compute the diff between two `policySatisfies` values.
 *
 * Both inputs are coerced + normalised before comparison, so case/order/
 * duplicate differences do not trigger a change.
 */
export function diffPolicySatisfies(before: unknown, after: unknown): PolicyDiff {
  const old_claims = normalise(before);
  const new_claims = normalise(after);

  const oldSet = new Set(old_claims);
  const newSet = new Set(new_claims);

  const added = new_claims.filter((c) => !oldSet.has(c));
  const removed = old_claims.filter((c) => !newSet.has(c));

  const changed = added.length > 0 || removed.length > 0;

  let diff_summary = '';
  if (changed) {
    const parts: string[] = [];
    if (added.length > 0) {
      parts.push(`added [${added.join(', ')}]`);
    }
    if (removed.length > 0) {
      parts.push(`removed [${removed.join(', ')}]`);
    }
    diff_summary = parts.join('; ');
  }

  return { changed, old_claims, new_claims, added, removed, diff_summary };
}
