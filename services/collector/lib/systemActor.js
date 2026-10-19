'use strict';

/**
 * systemActor.js — a turn with no human behind it (RunActor slice 2, FND_01M55X6TRMDS63SDZK3TDS63SD,
 * quox#1274). A workflow or scheduled agent:invoke reaches /chat org-scoped with no user; its tool
 * calls run as a SYSTEM actor: sub `system:<actor>` in the turn token, actor_type 'system'.
 * Least privilege (HYPERION design review 2026-10-17): it is never a direct human ask (the approval
 * gate compares ctx.userId with the human who asked, which a system id never matches), and it may use
 * only an explicit allowlist of tools (default deny). Memory stays, under the system actor's own id.
 */

// `workflow:<id>`, `schedule:<node>`, `service:invoke`: letters, digits and . _ : - only.
const SYSTEM_ACTOR_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
const SYSTEM_PREFIX = 'system:';

function isValidSystemActor(actor) {
  return typeof actor === 'string' && SYSTEM_ACTOR_RE.test(actor) && !actor.includes('..');
}

function isSystemActorId(id) {
  return typeof id === 'string' && id.startsWith(SYSTEM_PREFIX) && isValidSystemActor(id.slice(SYSTEM_PREFIX.length));
}

// DEFAULT DENY (HYPERION #11): a system actor may use ONLY these tools. Anything else, including
// every tool added later, is refused. Memory lands under the system actor's own id; slot_say only
// reaches the agent's bound slot; proof_status keeps its operator-only gate. A workflow agent that
// needs another tool gets it added here, reviewed, never by default.
const SYSTEM_ACTOR_TOOLS = new Set([
  'memory_save', 'memory_search', 'slot_say', 'proof_status', 'time_now', 'quox_command_lookup',
]);

/** null = allowed; otherwise a plain refusal for the model. */
function systemActorRefusal(toolName, ctx = {}) {
  if (!isSystemActorId(ctx && ctx.userId)) return null;
  if (SYSTEM_ACTOR_TOOLS.has(String(toolName || ''))) return null;
  return `${toolName} is not available to a scheduled or workflow run (it has no person behind it, and only a reviewed set of tools runs that way), so it did not run. Say so plainly; do not answer from memory.`;
}

module.exports = { isValidSystemActor, isSystemActorId, systemActorRefusal, SYSTEM_PREFIX, SYSTEM_ACTOR_TOOLS };
