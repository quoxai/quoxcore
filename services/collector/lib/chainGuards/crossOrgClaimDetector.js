'use strict';

/**
 * crossOrgClaimDetector.js
 *
 * AGH-CHAIN-3: Detects phrases that assert an external organisation approved,
 * confirmed, or authorised something — e.g. "Acme Corp approved the budget".
 *
 * Org names aren't enumerable, so we use business-context indicator phrases
 * to reduce false-positives (per feedback_regex_unit_tests_blind_to_false_positives).
 *
 * Bilingual: EN + ES.
 * ES word boundaries: JS \b is ASCII-only so we use (?=\W|$) lookahead for
 * verb endings with accented characters.
 */

// ── EN patterns ────────────────────────────────────────────────────────────────

/**
 * EN pattern 1: explicit business-context indicator word + org name + past-tense action.
 * e.g. "vendor Acme approved", "client FooBar confirmed"
 */
const EN_PATTERN_INDICATOR = /\b(?:org|organisation|organization|company|vendor|client|partner)\s+([A-Z][A-Za-z0-9& ]{1,40}?)\s+(approved|confirmed|authoris(?:ed|ied)|authorized|signed off|signed|agreed)\b/i;

/**
 * EN pattern 2: org name before "legal team", "compliance team", or "board" + past-tense action.
 * e.g. "Acme's legal team approved", "FooBar compliance team confirmed"
 */
const EN_PATTERN_LEGAL_TEAM = /\b([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+){0,3})(?:'s)?\s+(?:legal team|compliance team|board)\s+(approved|confirmed|authoris(?:ed|ied)|authorized)\b/i;

/**
 * EN pattern 3: org name with company suffix + past-tense action.
 * e.g. "Acme Corp approved", "FooBar Inc signed off"
 */
const EN_PATTERN_CORP_SUFFIX = /\b([A-Z][A-Za-z0-9&]+(?:\s+[A-Z][A-Za-z0-9&]+){0,2})\s+(?:Corp|Inc|Ltd|LLC|GmbH|SA|AG|BV|PLC|LLP)\s+(approved|confirmed|authorised|authorized|signed off|signed)\b/;

// ── ES patterns ────────────────────────────────────────────────────────────────

/**
 * ES pattern 1: explicit business-context indicator word + org name + past-tense action.
 * e.g. "empresa AcmeMex aprobó", "cliente FooBar firmó"
 */
const ES_PATTERN_INDICATOR = /\b(?:la\s+)?(?:org|organización|empresa|cliente|socio|proveedor)\s+([A-Z][A-Za-z0-9&áéíóúñÁÉÍÓÚÑ ]{1,40}?)\s+(aprob[óo]|confirm[óo]|autoriz[óo]|firm[óo])(?=\W|$)/i;

/**
 * ES pattern 2: org name before "equipo legal", "equipo de cumplimiento", or "consejo" + past-tense action.
 * e.g. "AcmeMex equipo legal aprobó"
 */
const ES_PATTERN_LEGAL_TEAM = /\b([A-Z][A-Za-z0-9&áéíóúñÁÉÍÓÚÑ]+(?:\s+[A-Z][A-Za-z0-9&áéíóúñÁÉÍÓÚÑ]+){0,2})(?:'s)?\s+(?:equipo legal|equipo de cumplimiento|consejo)\s+(aprob[óo]|confirm[óo]|autoriz[óo])(?=\W|$)/i;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Trim trailing apostrophe-s and whitespace from a captured org name.
 * "Acme's" → "Acme", "Acme Corp" → "Acme Corp"
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseOrgName(name) {
  return name.replace(/'s\s*$/, '').trim();
}

/**
 * Normalise a captured action verb to a consistent lowercase form.
 *
 * @param {string} verb
 * @returns {string}
 */
function normaliseAction(verb) {
  return verb.toLowerCase().trim();
}

/**
 * Try a list of [pattern, orgGroup, actionGroup] tuples against text.
 * Returns first hit or null.
 *
 * @param {string} text
 * @param {Array<[RegExp, number, number]>} patterns  — [regex, orgCaptureIndex, actionCaptureIndex]
 * @param {string} language
 * @returns {object|null}
 */
function tryPatterns(text, patterns, language) {
  for (const [pattern, orgIdx, actionIdx] of patterns) {
    const m = text.match(pattern);
    if (!m) continue;

    const org_name = normaliseOrgName(m[orgIdx]);
    if (!org_name) continue;

    const claim_action = normaliseAction(m[actionIdx]);

    return {
      detected: true,
      org_name,
      claim_text: m[0],
      claim_action,
      language,
    };
  }
  return null;
}

/**
 * detectCrossOrgClaim(text)
 *
 * Returns:
 *   { detected: true, org_name, claim_text, claim_action, language }
 *   { detected: false }
 *
 * org_name is the verbatim captured form (trimmed, apostrophe-s stripped).
 * claim_action is the captured verb lowercased.
 * language is 'en' or 'es'.
 */
function detectCrossOrgClaim(text) {
  if (!text || typeof text !== 'string') return { detected: false };

  // Try ES patterns first (more specific: accented verbs reduce EN collision)
  const esHit = tryPatterns(text, [
    [ES_PATTERN_INDICATOR, 1, 2],
    [ES_PATTERN_LEGAL_TEAM, 1, 2],
  ], 'es');
  if (esHit) return esHit;

  // Try EN patterns
  const enHit = tryPatterns(text, [
    [EN_PATTERN_INDICATOR, 1, 2],
    [EN_PATTERN_LEGAL_TEAM, 1, 2],
    [EN_PATTERN_CORP_SUFFIX, 1, 2],
  ], 'en');
  if (enHit) return enHit;

  return { detected: false };
}

module.exports = { detectCrossOrgClaim };
