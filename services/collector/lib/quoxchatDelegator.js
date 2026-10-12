/**
 * QCX-3.1 — Lightweight keyword-based agent delegator for the widget.
 *
 * Simplified version of the frontend agentDelegator. The widget path can't
 * import the frontend's delegator (wrong process); this module ships the
 * same spirit: keyword scoring → pick the strongest match; fall back to
 * COREY when nothing scores above threshold.
 *
 * Scoring:
 *   +10 per capability keyword appearing in the visitor's query
 *   +25 when the agent's name (e.g. "WARDEN") is mentioned explicitly
 *   +5 when a widget-configured tool name matches the query
 *
 * Threshold: 10 — a single capability hit is enough to delegate. Below
 * that we stay on COREY (the default persona).
 */

const { PERSONAS, getPersona } = require('./quoxchatPersonas');

const DEFAULT_PERSONA_ID = 'corey';
const DELEGATION_THRESHOLD = 10;

const CAPABILITY_POINTS = 10;
const EXPLICIT_NAME_POINTS = 25;
const TOOL_MATCH_POINTS = 5;

function _normalise(s) {
  return String(s || '').toLowerCase();
}

function scoreAgent(query, persona, opts = {}) {
  if (!persona) return 0;
  const q = _normalise(query);
  if (!q) return 0;
  let score = 0;

  // Explicit name mention — word boundary to avoid matching substrings of
  // unrelated words. Match the display name OR the persona id: rosters rename
  // display names (sentinel's is WARDEN) and visitors legitimately use either.
  for (const mention of [_normalise(persona.name), _normalise(persona.id)]) {
    const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped && new RegExp(`\\b${escaped}\\b`).test(q)) {
      score += EXPLICIT_NAME_POINTS;
      break;
    }
  }

  // Capability keyword matching. Exact substring match is enough for the
  // widget context — false positives bias towards delegation, which still
  // gets a safety-preambled prompt.
  for (const cap of persona.capabilities || []) {
    const c = _normalise(cap);
    if (c && q.includes(c)) score += CAPABILITY_POINTS;
  }

  // Tool name match — widget's configured tools bump relevance.
  const tools = Array.isArray(opts.toolNames) ? opts.toolNames : [];
  for (const t of tools) {
    const tn = _normalise(t).replace(/_/g, ' ');
    if (tn && q.includes(tn)) score += TOOL_MATCH_POINTS;
  }

  return score;
}

/**
 * Picks the best persona for a visitor message. Returns a decision object:
 *   {
 *     persona_id: string,
 *     delegated: boolean,     // true when a specialist was picked (not COREY)
 *     score: number,          // winner's score
 *     threshold: number,
 *     reason: string,         // human-readable why
 *     alternatives: [{persona_id, score}] // next-best-3, for the admin UI
 *   }
 */
function pickAgent(query, opts = {}) {
  const q = _normalise(query);
  const scores = [];

  for (const persona of Object.values(PERSONAS)) {
    if (persona.id === DEFAULT_PERSONA_ID) continue; // evaluated as fallback
    const s = scoreAgent(q, persona, opts);
    if (s > 0) scores.push({ persona_id: persona.id, score: s });
  }
  scores.sort((a, b) => b.score - a.score);

  const top = scores[0];
  if (!top || top.score < DELEGATION_THRESHOLD) {
    return {
      persona_id: DEFAULT_PERSONA_ID,
      delegated: false,
      score: top?.score || 0,
      threshold: DELEGATION_THRESHOLD,
      reason: top
        ? `top specialist ${top.persona_id} scored ${top.score}, below threshold ${DELEGATION_THRESHOLD}`
        : 'no specialist matched keywords',
      alternatives: scores.slice(0, 3),
    };
  }

  return {
    persona_id: top.persona_id,
    delegated: true,
    score: top.score,
    threshold: DELEGATION_THRESHOLD,
    reason: `matched ${top.persona_id} (score=${top.score})`,
    alternatives: scores.slice(1, 4),
  };
}

module.exports = {
  pickAgent,
  scoreAgent,
  DELEGATION_THRESHOLD,
  DEFAULT_PERSONA_ID,
  getPersona,
};
