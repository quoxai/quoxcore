'use strict';

/**
 * detectFulfillmentClaim(text)
 *
 * Detects past-tense fulfillment claims that REFERENCE a prior commitment.
 * Not bare past-tense (that's verifyClaimedActions in responseContract) —
 * this specifically catches cross-turn "as promised / as I said / I've now done X" patterns.
 *
 * Returns:
 *   { detected: true, claim_text, language, claim_kind }
 *   { detected: false }
 */

const EN_PATTERNS = [
  { re: /\bas\s+(I\s+)?promised\b/i, kind: 'as_promised' },
  { re: /\bas\s+(I\s+)?(said|mentioned|told\s+you|discussed|agreed)\b/i, kind: 'as_said' },
  { re: /\bI(['']ve|\s+have)\s+(now\s+)?(sent|emailed|forwarded|delivered|created|scheduled|started|saved|routed)\b/i, kind: 'completed' },
  { re: /\b(the|that)\s+(report|email|task|workflow|meeting)\s+(I|that\s+I)\s+(sent|created|started|saved|scheduled)\b/i, kind: 'referenced_completion' },
];

// Note: JS \b word boundary does not work after Unicode accented chars.
// Use (?=\W|$) lookahead instead of trailing \b for patterns ending in accented chars.
const ES_PATTERNS = [
  { re: /\bcomo\s+(te\s+)?promet[ií](?=\W|$)/i, kind: 'as_promised' },
  { re: /\bcomo\s+(te\s+)?(dije|mencion[eé]|coment[eé])(?=\W|$)/i, kind: 'as_said' },
  { re: /\bya\s+(te\s+)?(envi[eé]|mand[eé]|cre[eé]|guard[eé])(?=\W|$)/i, kind: 'completed' },
];

function detectFulfillmentClaim(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { detected: false };
  }

  for (const { re, kind } of EN_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      return {
        detected: true,
        claim_text: match[0],
        language: 'en',
        claim_kind: kind,
      };
    }
  }

  for (const { re, kind } of ES_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      return {
        detected: true,
        claim_text: match[0],
        language: 'es',
        claim_kind: kind,
      };
    }
  }

  return { detected: false };
}

module.exports = { detectFulfillmentClaim };
