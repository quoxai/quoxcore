'use strict';

const fs = require('fs');
const path = require('path');
const entityAssistantLoader = require('../entityAssistantLoader');

/**
 * crossAgentClaimDetector.js
 *
 * AGH-CHAIN-2: Detects phrases that assert another (known) agent completed an
 * action, e.g. "WARDEN completed the audit", "Cipher reported the result".
 *
 * KNOWN_AGENTS is loaded from entityAssistantLoader (the single source of
 * truth for agent identity — src/config/entities/assistants/*.json) at
 * module init, so newly-added agents are picked up automatically. Falls
 * back to a hardcoded list if the loader is empty or throws (e.g. running
 * outside the repo checkout).
 *
 * Scope (v1, AGH-CHAIN-FU-KNOWNAGENTS #109): core agents only. Custom /
 * POWERS agents are per-org DB rows (not entity JSON files) and are
 * deliberately NOT unioned in here — a cross-agent claim naming a custom
 * agent will not be recognised by this walker. Revisit if that's ever
 * observed in practice.
 *
 * Bilingual: EN + ES.
 * ES word boundaries: JS \b is ASCII-only so we use (?=\W|$) lookahead for
 * verb endings with accented characters (completó, envió, etc.).
 */

const FALLBACK_AGENTS = [
  'quox', 'sentinel', 'nova', 'cipher', 'gemini',
  'atlas', 'metrics', 'insight', 'oracle', 'beacon',
  'codex', 'archivist', 'corey', 'weaver', 'horus', 'keeper',
  'toolsmith',
];

function buildKnownAgents() {
  try {
    let ids = entityAssistantLoader.listAssistants();
    if (!ids || ids.length === 0) {
      const devPath = path.join(__dirname, '../../../../src/config/entities/assistants');
      const dockerPath = '/app/entity-assistants';
      const assistantsPath = fs.existsSync(dockerPath) ? dockerPath : devPath;
      entityAssistantLoader.loadAssistants(assistantsPath);
      ids = entityAssistantLoader.listAssistants();
    }
    if (ids && ids.length > 0) {
      return new Set(ids.map((id) => id.toLowerCase()));
    }
  } catch (err) {
    console.warn(`[crossAgentClaimDetector] Failed to load KNOWN_AGENTS from entityAssistantLoader — using fallback list: ${err.message}`);
  }
  return new Set(FALLBACK_AGENTS);
}

const KNOWN_AGENTS = buildKnownAgents();

// ── EN past-tense verbs ────────────────────────────────────────────────────────

const EN_VERBS = '(?:completed|finished|sent|created|started|reported|told|delivered|saved|scheduled|routed|launched|emitted|signed)';

/**
 * EN pattern 1: "agent WARDEN completed" — explicit "agent" prefix.
 * Prefix "agent " is a strong signal; any casing.
 */
const EN_PATTERN_AGENT_PREFIX = new RegExp(
  `\\bagent\\s+([A-Z][A-Za-z]+)\\s+${EN_VERBS}\\b`,
  'i'
);

/**
 * EN pattern 2: "WARDEN completed" — all-caps name directly followed by verb.
 * Deliberately requires all-caps to reduce false positives on common English words.
 */
const EN_PATTERN_ALLCAPS = new RegExp(
  `\\b([A-Z]{2,})\\s+${EN_VERBS}\\b`
);

/**
 * EN pattern 3: "Cipher reported" — title-case name (capital first, lowercase rest)
 * optionally followed by "just".
 * Counter-case guarded: first-person "I" is title-case but not in KNOWN_AGENTS.
 */
const EN_PATTERN_TITLECASE = new RegExp(
  `\\b([A-Z][a-z]+)\\s+(?:just\\s+)?${EN_VERBS}\\b`
);

// ── ES past-tense verbs ────────────────────────────────────────────────────────

// Use (?=\W|$) as trailing boundary because \b is ASCII-only and won't anchor
// correctly after accented characters like completó, envió.
const ES_VERBS = '(?:complet[oó]|termin[oó]|envi[oó]|cre[oó]|inici[oó]|report[oó]|coment[oó]|firm[oó])';

/**
 * ES pattern 1: "agent WARDEN completó" — explicit "agent" prefix.
 */
const ES_PATTERN_AGENT_PREFIX = new RegExp(
  `\\bagent\\s+([A-Z][A-Za-z]+)\\s+${ES_VERBS}(?=\\W|$)`,
  'i'
);

/**
 * ES pattern 2: "WARDEN completó" — all-caps name.
 */
const ES_PATTERN_ALLCAPS = new RegExp(
  `\\b([A-Z]{2,})\\s+${ES_VERBS}(?=\\W|$)`
);

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract the verb from the matched substring after the agent name.
 * We extract it from the full match string — find the last word that isn't the
 * agent name (which appears at the start of the match).
 */
function extractVerb(matchText) {
  // The match is "AgentName [just] verb". Split and take last word.
  const words = matchText.trim().split(/\s+/);
  return words[words.length - 1].toLowerCase();
}

/**
 * Try a list of regex patterns against text, filter by KNOWN_AGENTS,
 * return first hit or null.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @param {string} language
 * @returns {object|null}
 */
function tryPatterns(text, patterns, language) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;

    const rawName = m[1];
    const agentId = rawName.toLowerCase();
    if (!KNOWN_AGENTS.has(agentId)) continue;

    // Extract the claimed action verb from the full match text
    const claim_action = extractVerb(m[0]);

    return {
      detected: true,
      agent_name: rawName,
      agent_id: agentId,
      claim_text: m[0],
      claim_action,
      language,
    };
  }
  return null;
}

/**
 * detectCrossAgentClaim(text)
 *
 * Returns:
 *   { detected: true, agent_name, agent_id, claim_text, claim_action, language }
 *   { detected: false }
 *
 * agent_id is always lowercase.
 * agent_name is the verbatim captured form from the text.
 * claim_action is the captured verb lowercased.
 */
function detectCrossAgentClaim(text) {
  if (!text || typeof text !== 'string') return { detected: false };

  // Try ES patterns first (more specific: accented verbs reduce EN collision)
  const esHit = tryPatterns(text, [ES_PATTERN_AGENT_PREFIX, ES_PATTERN_ALLCAPS], 'es');
  if (esHit) return esHit;

  // Try EN patterns
  const enHit = tryPatterns(text, [EN_PATTERN_AGENT_PREFIX, EN_PATTERN_ALLCAPS, EN_PATTERN_TITLECASE], 'en');
  if (enHit) return enHit;

  return { detected: false };
}

module.exports = { detectCrossAgentClaim, KNOWN_AGENTS };
