/**
 * Self-Knowledge Implant Injection — MEM-INJECT Phase 1
 *
 * Before: self-knowledge / implant context (`[SELF-KNOWLEDGE]`-style blocks)
 * was assembled ONLY client-side (src/services/quoxContext.js), and only
 * when isQuoxQuery(text) matched a narrow keyword gate — so most turns, and
 * every non-browser caller (workflow/objective/team/delegated invoke via
 * /api/internal/agents/invoke), got none at all.
 *
 * After: this module builds an equivalent block server-side, from the SAME
 * implant registry the dashboard's Mirror tab renders
 * (src/config/cognitiveImplants.js — loaded via agentTools.js's
 * loadCognitiveImplants(), already used by the execution_intelligence
 * mirror_index/implant_detail tool actions) plus the collector's live
 * fleet/guardian summary (server.js's getCollectorMirrorCompact()).
 * Applied UNCONDITIONALLY at chat dispatch (not gated on isQuoxQuery).
 *
 * Honesty constraint (NO GOVERNANCE THEATER): this module has no access to
 * per-org license/activation state or live per-implant health scores (those
 * live in the dashboard's frontend-only cognitiveTopologyService.js data
 * fetchers). It reports what it can actually verify — real implant
 * names/tiers/counts from the registry, and the real fleet/guardian line —
 * and says so explicitly rather than fabricating a "N healthy implants"
 * claim.
 *
 * Kill-flag: QUOX_SERVER_SELFKNOWLEDGE_ENABLED, default ON. Set to the
 * literal string 'false' to disable without a redeploy.
 *
 * Never throws — any failure (registry load error, malformed config, etc.)
 * degrades to '' so a chat turn is never blocked by this.
 */

const MAX_TOKENS = 1200; // QUOXON-MIRROR: room for the org Mirror summary (~1500 chars) beside the situation
const CHARS_PER_TOKEN = 4; // same rough approximation used by memoryImplant.js
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

function isSelfKnowledgeEnabled(env = process.env) {
  return env.QUOX_SERVER_SELFKNOWLEDGE_ENABLED !== 'false';
}

/**
 * Truncate text to a char budget, cutting at the last full line boundary
 * within budget rather than mid-word/mid-line, with a visible marker.
 * (Same convention as memoryImplant.js's truncateToCharBudget.)
 */
function truncateToCharBudget(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const clean = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${clean}\n[...truncated]`;
}

/**
 * Build the [SELF-KNOWLEDGE] block from the live cognitive-implants registry
 * + the collector's fleet/guardian summary. Never throws.
 */
async function buildSelfKnowledgeImplant({
  agentId,
  orgId,
  loadCognitiveImplants,
  getCollectorMirrorCompact,
  getOrgMirrorSummary,
  maxChars = MAX_CHARS,
  env = process.env,
} = {}) {
  try {
    if (!isSelfKnowledgeEnabled(env)) return '';
    if (typeof loadCognitiveImplants !== 'function') {
      console.warn('[SelfKnowledgeImplant] loadCognitiveImplants dependency missing, proceeding without self-knowledge context');
      return '';
    }

    const implants = await loadCognitiveImplants();
    const entries = Object.values(implants || {});
    if (entries.length === 0) return '';

    const byTier = entries.reduce((acc, cfg) => {
      const tier = cfg?.tier || 'unknown';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});
    const tierSummary = Object.entries(byTier)
      .map(([tier, count]) => `${count} ${tier}`)
      .join(', ');

    const names = entries.map(cfg => cfg?.name).filter(Boolean);

    const lines = ['[SELF-KNOWLEDGE]'];
    lines.push(
      `You are Quox. This organisation's QuoxMind cognitive implant registry has ${entries.length} implants ` +
      `(${tierSummary}): ${names.join(', ')}.`
    );
    // QUOXON-MIRROR: this org's Mirror, built server-side from each owning service
    // (lib/mirrorBuilder.js). Only asked for with a real org id, never a default org.
    let orgMirror = '';
    if (orgId && typeof getOrgMirrorSummary === 'function') {
      try { orgMirror = (await getOrgMirrorSummary(orgId)) || ''; } catch (mErr) {
        console.warn(`[SelfKnowledgeImplant] org Mirror unavailable: ${mErr.message}`);
      }
    }
    if (orgMirror) {
      lines.push('The QuoxMind Mirror below is this organisation\'s live state, read from each service for this org only. ' +
        'Quote its numbers; an "Unknown" line says why a value could not be read, so say that rather than guessing.');
      lines.push(orgMirror);
    } else {
      // Honesty line — do not claim health/activation state we cannot verify here.
      lines.push(
        'Implant names/tiers/counts above come from the live registry (real, not hardcoded). ' +
        'Per-org license/activation state and live per-implant health scores are NOT available to ' +
        'this server-side block — never claim specific health numbers or "all healthy" from this alone.'
      );
    }

    if (typeof getCollectorMirrorCompact === 'function') {
      try {
        const mirror = getCollectorMirrorCompact();
        if (mirror) lines.push(mirror);
      } catch (mirrorErr) {
        console.warn(`[SelfKnowledgeImplant] getCollectorMirrorCompact failed: ${mirrorErr.message}`);
      }
    }

    const situation = buildSituationLines({ agentId, orgId });
    if (situation.length) lines.push(...situation);

    if (agentId) lines.push(`Current agent handling this turn: ${agentId}.`);

    lines.push('[/SELF-KNOWLEDGE]');
    return truncateToCharBudget(lines.join('\n'), maxChars);
  } catch (err) {
    console.error(`[SelfKnowledgeImplant] build failed, proceeding without self-knowledge context: ${err.message}`);
    return '';
  }
}

/**
 * LUCID in the background: CommanderQ knows the current situation (what needs
 * the owner, each area in one line, what LUCID cannot see) without any widget.
 * Read-only: never advances anyone's "since you last looked" cursor. Only the
 * orchestrator gets it, so specialist agents stay focused. Never throws.
 */
const SITUATION_AGENTS = new Set(['quox', 'commanderq', 'lucid']);
function buildSituationLines({ agentId, orgId, situationFor } = {}) {
  try {
    if (!orgId) return [];
    if (agentId && !SITUATION_AGENTS.has(String(agentId).toLowerCase())) return [];
    const journal = require('./lucid/journal.js');
    if (!journal.isReady()) return [];
    const fn = situationFor || require('./lucid/routes.js').situationFor;
    const { situation } = fn(orgId, { since: 'last', viewer: 'commanderq', surface: 'chat', advance: false });
    const out = ['[SITUATION from LUCID, the background awareness; use it to answer "what is going on" and to anticipate, never recite it unprompted]'];
    out.push(`Briefing: ${situation.L0}`);
    for (const a of situation.areas || []) {
      if (a.state === 'ok' && !a.needs) continue;
      out.push(`- ${a.label}: ${a.L0}`);
    }
    out.push('For detail on any item call lucid_item (ref) or lucid_situation, or delegate to the lucid agent. LUCID never acts on its own; fixes go through approvals.');
    return out;
  } catch (err) {
    console.warn(`[SelfKnowledgeImplant] LUCID situation unavailable: ${err.message}`);
    return [];
  }
}

/**
 * Merge the self-knowledge block into sanitizedContext.quox_context. The
 * server-side block is placed first (server wins on precedence/ordering)
 * but any existing (client-supplied, e.g. dynamic weather/host) quox_context
 * is preserved rather than overwritten — the two are additive, not
 * exclusive. If the implant is empty (registry load failure, kill-flag
 * off), the existing value is left untouched so the chat turn proceeds
 * unaffected.
 */
function applySelfKnowledgeImplant(sanitizedContext, selfKnowledgeBlock) {
  if (!selfKnowledgeBlock) return sanitizedContext;
  const existing = sanitizedContext?.quox_context;
  const merged = existing ? `${selfKnowledgeBlock}\n\n${existing}` : selfKnowledgeBlock;
  return { ...sanitizedContext, quox_context: merged };
}

module.exports = {
  buildSelfKnowledgeImplant,
  applySelfKnowledgeImplant,
  truncateToCharBudget,
  isSelfKnowledgeEnabled,
  buildSituationLines,
  MAX_TOKENS,
};
