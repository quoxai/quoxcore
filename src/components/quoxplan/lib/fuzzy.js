/**
 * Simple subsequence (fuzzy-ish) matcher for the command palette. Not a full
 * fuzzy-scoring engine on purpose — this is "good enough" search over a
 * single roadmap's streams + a handful of verbs.
 *
 * Returns a score (higher = better) or null when `needle` is not a
 * subsequence of `haystack` (case-insensitive).
 */
export function subsequenceScore(needle, haystack) {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  let hi = 0;
  let score = 0;
  let consecutiveBonus = 0;
  let lastMatchIdx = -1;

  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    const idx = h.indexOf(ch, hi);
    if (idx === -1) return null;
    if (idx === lastMatchIdx + 1) {
      consecutiveBonus += 2;
    }
    score += 1;
    lastMatchIdx = idx;
    hi = idx + 1;
  }

  // Prefer matches that start earlier and are more contiguous, and shorter
  // haystacks (tighter matches) over longer ones.
  const startBonus = Math.max(0, 10 - h.indexOf(n[0]));
  return score + consecutiveBonus + startBonus - h.length * 0.01;
}

export function fuzzyFilter(needle, items, getText) {
  if (!needle) return items;
  const scored = [];
  for (const item of items) {
    const score = subsequenceScore(needle, getText(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
