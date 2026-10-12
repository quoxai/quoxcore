/**
 * Quox platform-layer prompt fragments.
 *
 * Single source of truth for prompt text that must appear in EVERY agent's
 * effective system prompt on the collector (chat) path. Import here; do not
 * duplicate the strings inline.
 *
 * Cross-repo note: quoxflow/src/agentic/agent-platform-prompt.ts carries the
 * same strings for the executor path. Both definitions must remain byte-identical
 * (audited in QSKL slice 7).
 */

/**
 * Three-layer knowledge guidance paragraph added by QSKL-13.
 * Extracted here so future additions share this module.
 */
const THREE_LAYER_MEMORY_NOTE = `### Three knowledge layers — pick the right one

- MEMORY: durable facts, observations, and constraints. Use memory_save to write, memory_search to recall. memory_save REJECTS memory_role='procedure' (use skill_manage instead) and memory_role='session_history' (use session_search instead).

- SKILLS: procedural how-tos as versioned markdown crystals. Discover with skills_list, load on demand with skill_view, author or patch with skill_manage(action='create'|'update'|...). Use this layer for any 'how do I X' procedure you'd otherwise be tempted to memorise.

- SESSIONS: past task transcripts (workflow runs, agent envelopes — auto-captured as you work). Recall with session_search({query:'<keywords>', limit:10}) when you need 'what did I do last time about X?'. Do NOT write session history to memory; it is already captured automatically.`;

/**
 * QSKL-14a: Proactive skill-patch directive.
 *
 * Instructs agents to patch stale skills immediately rather than waiting for
 * an explicit instruction. skill_manage(action='patch') routes through
 * Crystal-eval and emits a VOLT audit envelope automatically.
 */
const SKILL_PATCH_DIRECTIVE = `When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked. Patches run through Crystal-eval before promotion and emit a VOLT audit envelope automatically.`;

module.exports = {
  THREE_LAYER_MEMORY_NOTE,
  SKILL_PATCH_DIRECTIVE,
};
