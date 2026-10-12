/**
 * Correlation-ID sibling utilities.
 *
 * Pre-AEE-CORE-1 data fragmented one user action across multiple corrs:
 *   CHAT_<ts>_<rand>  + mcp-<ts±~200ms>   + TOOL_<id>
 *   SHELL_<ts>        + term-<ts>
 *
 * After AEE-CORE-1 this no longer happens — new envelopes share a single
 * corr. But the historical table still has millions of split records and
 * the detail view needs to stitch them back together so the user sees the
 * full chain when opening a legacy conversation.
 *
 * These helpers are pure: they compute what to look up; the route does the
 * actual DB query.
 */

// Legacy sibling prefixes we care about joining into a primary corr's view.
// Keyed by the primary corr's prefix.
const SIBLING_RULES = [
  {
    // Chat primary → mcp- session partner + TOOL_ orphans + SESSION_ (in
    // case an earlier SESSION_ still exists for the same moment).
    primary: /^(CHAT_|SESSION_|CONV_)/,
    siblingLikes: ['mcp-%', 'MCP_%', 'TOOL_%'],
  },
  {
    // Shell primary → term- terminal partner.
    primary: /^SHELL_/,
    siblingLikes: ['term-%', 'TERM_%'],
  },
];

/**
 * Extract a millisecond-epoch timestamp from a correlation id, if the corr
 * format embeds one. Returns null otherwise.
 *
 * Supported shapes:
 *   CHAT_1776604891303_2d1eab26  → 1776604891303
 *   SESSION_1776604891303_abcdef → 1776604891303
 *   SHELL_1776604891303_hex      → 1776604891303
 *   mcp-1776604891523            → 1776604891523
 *   MCP_1776604891523            → 1776604891523
 */
function extractCorrTimestamp(corr) {
  if (!corr || typeof corr !== 'string') return null;
  // `PREFIX_1776604891303_…` or `prefix-1776604891523`
  const m = corr.match(/[_-](1[0-9]{12})(?:[_-]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Get the list of SQL LIKE patterns to search for legacy sibling corrs of
 * a given primary corr. Returns an empty array when no rule matches.
 */
function getSiblingLikePatterns(primaryCorr) {
  if (!primaryCorr || typeof primaryCorr !== 'string') return [];
  for (const rule of SIBLING_RULES) {
    if (rule.primary.test(primaryCorr)) return [...rule.siblingLikes];
  }
  return [];
}

/**
 * Build the ts range (ms) for sibling lookup. Returns null if the primary
 * corr has no extractable timestamp (in which case: no sibling lookup —
 * fall back to primary-corr-only, which is the current behaviour).
 *
 * Default window: 5 seconds either side of the embedded timestamp. This
 * handles observed ~200ms drift between CHAT_ and mcp- siblings while
 * being tight enough to avoid false joins across unrelated requests.
 */
function getSiblingTimeWindow(primaryCorr, windowMs = 5000) {
  const ts = extractCorrTimestamp(primaryCorr);
  if (ts === null) return null;
  return { min: ts - windowMs, max: ts + windowMs };
}

module.exports = {
  extractCorrTimestamp,
  getSiblingLikePatterns,
  getSiblingTimeWindow,
  SIBLING_RULES,
};
