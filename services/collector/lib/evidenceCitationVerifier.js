/**
 * Evidence-Cited Answers — verifier pass (COMMANDERQ P3 / E1)
 *
 * The problem: an agent will state a LIVE system fact ("3 approvals pending",
 * "the collector is running", "5 of 12 phases done") from its own head — from
 * training, from an earlier turn, or from a plausible guess — with no tool
 * behind it this turn. That is the exact failure the honesty rules name
 * ([unknown-rendered-as-certain], [silent-fallback-can-assert-a-falsehood]):
 * a current-state claim asserted as fact when nothing was actually checked.
 *
 * The fix has two halves that MUST ship together:
 *   1. A prompt directive (evidenceCitationImplant.js) that TEACHES the agent
 *      to cite a live-state claim inline — `(source: <tool_name>)` — from a
 *      tool it called this turn, or else disclaim it as unverified.
 *   2. This module: a post-response pass that MEASURES the result — detects
 *      live-state claims and flags the ones carrying neither an inline source
 *      nor an explicit unverified disclaimer.
 *
 * Modelled on lib/brainCitationTrace.js: substring detection, counts-only
 * evidence envelope (no claim text ever leaves in the receipt), best-effort,
 * NEVER throws, NEVER blocks a response. It annotates `body.evidence_audit`
 * for the caller and emits a `quox.chat.evidence_audit` AEE envelope. The
 * flag rate is a behaviour signal, not a gate — it starts high and falls as
 * the agent learns to cite. Blocking on it would silence correct answers on a
 * heuristic, which is the opposite of honest.
 *
 * HONEST SCOPE (no groundedness theater): this pass does NOT verify a claim is
 * TRUE, and does not re-run evidence tools. It answers one narrower, provable
 * question: did the agent attach a source (or a disclaimer) to a live-state
 * assertion? Attribution of a specific claim to a specific tool result is left
 * to the inline `(source:)` marker the agent writes — we do not guess it.
 *
 * Kill-flag: QUOX_EVIDENCE_CITED_ENABLED, default ON. Set to the literal
 * string 'false' to disable without a redeploy.
 */

'use strict';

function isEnabled(env = process.env) {
  return env.QUOX_EVIDENCE_CITED_ENABLED !== 'false';
}

// Cap on how many claim spans we surface back to the caller, and how long each
// span is echoed — the annotation is a debugging/UX aid, not a transcript.
const MAX_SPANS = 12;
const SPAN_MAX_CHARS = 160;

// A sentence is a candidate LIVE-STATE claim only when it pairs a state/quantity
// signal WITH a system-domain noun. Requiring both keeps this precise (few false
// positives) rather than flagging every sentence that happens to contain a
// number. Recall is deliberately partial — see HONEST SCOPE above.
const STATE_SIGNAL = /\b(\d+|running|down|up|online|offline|healthy|unhealthy|degraded|active|inactive|pending|approved|rejected|complete|completed|failed|passing|passed|deployed|live|enabled|disabled|exists?|present|missing|absent|none|zero|no\b)\b/i;

const DOMAIN_NOUN = /\b(approvals?|phases?|streams?|deploys?|deployments?|collectors?|containers?|services?|hosts?|agents?|tools?|policies|policy|findings?|envelopes?|runs?|snapshots?|backups?|nodes?|orgs?|organi[sz]ations?|sessions?|builds?|tenants?|receipts?|witnesses?|users?|plugins?|integrations?|connectors?)\b/i;

// Sentences that are conditional, instructional, or hypothetical are NOT
// present-tense state assertions and are exempt.
const NON_ASSERTION = /^(if\b|to\b|you (can|could|should|may|might|would)|i (can|could|will|would|should)|let('?s| us)|please\b|when you|once you|for example|e\.g\.|consider\b|try\b|would you|do you|shall i|should i)/i;

// The agent honestly flagging its own uncertainty. A disclaimed claim is NOT a
// silent uncited claim — it is exactly the disclosure the directive asks for.
const DISCLAIMER = /(haven'?t checked|not checked|didn'?t (?:verify|check)|did not (?:verify|check)|from memory|may be stale|might be stale|possibly stale|unverified|not (?:yet )?verified|can'?t confirm|cannot confirm|not sure|unsure|as of my last|i believe|i think|probably|might be|may be|as far as i know|if i recall|to my knowledge)/i;

// An inline source marker the directive asks for: "(source: query_envelopes)".
const SOURCE_MARKER = /\(\s*sources?\s*:\s*[a-z0-9_ ,./-]+\)/i;

/**
 * Split text into rough sentences. We strip fenced code blocks first — a state
 * claim inside a code sample is data the agent is showing, not an assertion it
 * is making, and code is riddled with numbers/keywords that would false-flag.
 */
function toSentences(text) {
  if (typeof text !== 'string' || !text) return [];
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, ' ')   // fenced code
    .replace(/`[^`]*`/g, ' ');         // inline code
  // Split on sentence terminators and hard line breaks. Bullet lists count as
  // separate claims (each line is its own assertion).
  return withoutCode
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Does this tools-used list name a tool inside the sentence? An agent that
 * writes "query_envelopes shows 3 pending" has cited a real tool it called,
 * which is as good as the "(source:)" marker.
 */
function mentionsUsedTool(sentence, toolsUsed) {
  if (!Array.isArray(toolsUsed) || toolsUsed.length === 0) return false;
  const lower = sentence.toLowerCase();
  for (const t of toolsUsed) {
    const name = typeof t === 'string' ? t : (t && (t.name || t.tool || t.id));
    if (!name || typeof name !== 'string' || name.length < 4) continue;
    if (lower.includes(name.toLowerCase())) return true;
  }
  return false;
}

function isStateClaim(sentence) {
  if (NON_ASSERTION.test(sentence)) return false;
  return STATE_SIGNAL.test(sentence) && DOMAIN_NOUN.test(sentence);
}

/**
 * Classify a single live-state claim.
 * @returns {'cited'|'disclaimed'|'uncited'}
 */
function classifyClaim(sentence, toolsUsed) {
  if (SOURCE_MARKER.test(sentence) || mentionsUsedTool(sentence, toolsUsed)) return 'cited';
  if (DISCLAIMER.test(sentence)) return 'disclaimed';
  return 'uncited';
}

function trimSpan(sentence) {
  const s = sentence.replace(/\s+/g, ' ').trim();
  return s.length > SPAN_MAX_CHARS ? `${s.slice(0, SPAN_MAX_CHARS - 1)}…` : s;
}

/**
 * Emit a counts-only evidence envelope. No claim text, no spans, no answer —
 * same posture as brainCitationTrace's quox.brain.cited (counts only).
 */
function emitAudit(auditFn, { corr, agentId, orgId, userId, stats }) {
  if (typeof auditFn !== 'function') return;
  try {
    auditFn({
      type: 'event',
      from: `agent.${agentId || 'quox'}`,
      to: userId ? `human.${userId}` : 'system.collector',
      intent: 'quox.chat.evidence_audit',
      corr: corr || null,
      reply_to: null,
      org_id: orgId || null,
      payload: {
        org: orgId || null,
        state_claims: stats.stateClaims,
        cited: stats.cited,
        disclaimed: stats.disclaimed,
        uncited: stats.uncited,
      },
    });
  } catch (_) { /* evidence is best-effort, never fatal */ }
}

/**
 * Audit the final answer's live-state claims for citations.
 *
 * @param {string} finalText  the answer the user will read
 * @param {object} opts
 *   toolsUsed  {Array}    tools actually invoked this turn (body.tools_used)
 *   agentId    {string}   selected_agent
 *   orgId      {string}   jwtOrgId
 *   userId     {string}   jwtUserId
 *   corr       {string}   aoclCtx.corr
 *   auditFn    {Function} storeAuditEnvelope (injected for tests)
 *   env        {object}   process.env override (tests)
 * @returns {object} annotation suitable for body.evidence_audit; always safe.
 */
function auditEvidenceCitations(finalText, opts = {}) {
  const { toolsUsed = [], agentId, orgId, userId, corr, auditFn, env = process.env } = opts;

  if (!isEnabled(env)) return { enabled: false };

  try {
    const sentences = toSentences(finalText);
    const uncitedSpans = [];
    let stateClaims = 0, cited = 0, disclaimed = 0, uncited = 0;

    for (const sentence of sentences) {
      if (!isStateClaim(sentence)) continue;
      stateClaims += 1;
      const verdict = classifyClaim(sentence, toolsUsed);
      if (verdict === 'cited') cited += 1;
      else if (verdict === 'disclaimed') disclaimed += 1;
      else {
        uncited += 1;
        if (uncitedSpans.length < MAX_SPANS) uncitedSpans.push(trimSpan(sentence));
      }
    }

    const stats = { stateClaims, cited, disclaimed, uncited };

    // Only spend an envelope when there was something to measure — the vast
    // majority of turns make no live-state claim at all, and must stay cheap.
    if (stateClaims > 0) {
      emitAudit(auditFn, { corr, agentId, orgId, userId, stats });
    }

    return {
      enabled: true,
      state_claims: stateClaims,
      cited,
      disclaimed,
      uncited,
      uncited_spans: uncitedSpans,
      tools_used: Array.isArray(toolsUsed)
        ? toolsUsed.map(t => (typeof t === 'string' ? t : (t && (t.name || t.tool || t.id)))).filter(Boolean)
        : [],
    };
  } catch (err) {
    // Never let an honesty annotation break a chat turn.
    console.warn(`[EvidenceCited] audit failed (non-fatal): ${err && err.message}`);
    return { enabled: true, error: 'audit_failed' };
  }
}

module.exports = {
  auditEvidenceCitations,
  // exported for unit tests
  isStateClaim,
  classifyClaim,
  toSentences,
  isEnabled,
};
