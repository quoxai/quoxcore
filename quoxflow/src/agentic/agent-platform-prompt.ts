/**
 * Quox platform-layer prompt fragments for the quoxflow agentic executor.
 *
 * Single source of truth for directive text that must appear in every agent's
 * thinkNonBrowser prompt on the executor path.
 *
 * Cross-repo note: quox-dashboard/services/collector/lib/quoxPlatformPrompts.js
 * carries the same strings for the collector (chat) path. Both definitions must
 * remain byte-identical (audited in QSKL slice 7).
 */

/**
 * QSKL-14a: Proactive skill-patch directive.
 *
 * Instructs agents to patch stale skills immediately rather than waiting for
 * an explicit instruction. skill_manage(action='patch') routes through
 * Crystal-eval and emits a VOLT audit envelope automatically.
 */
export const SKILL_PATCH_DIRECTIVE =
  "When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked. Patches run through Crystal-eval before promotion and emit a VOLT audit envelope automatically.";

/**
 * Builds the platform-layer suffix appended to the RULES section of every
 * non-browser agent's think() prompt.
 *
 * @param _agentId - Reserved for future per-agent customisation (unused today).
 */
export function buildNonBrowserPlatformSuffix(_agentId: string): string {
  return `- ${SKILL_PATCH_DIRECTIVE}`;
}
