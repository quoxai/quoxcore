'use strict';

// Pure (no env, no I/O) so libraries can import it without loading httpAuth,
// which exits at require time when the JWT secret is absent.
/**
 * P0b (QUOXPERTICUS DEC-2) — derive the caller's actor_type from the CREDENTIAL
 * CLASS, never a self-asserted claim. Fail-closed: agent markers win over
 * 'human' so an agent-scoped token can never be read as human.
 *   - req.mcpToken (qmcp_ path) OR req.user.{agent_id|actor_type=agent|agent_ops|attach_lease_id} -> 'agent'
 *     (shared classifier: services/shared/principal.cjs)
 *   - req.service === true (raw INTERNAL_SERVICE_KEY)  -> 'service'
 *   - req.user present (plain human JWT)               -> 'human'
 *   - otherwise                                        -> null (unauthenticated)
 * @returns {'human'|'agent'|'service'|null}
 */
const { isNonHumanPrincipal } = loadPrincipal();

function loadPrincipal() {
  // services/shared is ../../shared in the source tree, /app/services-shared in the image.
  for (const p of ['../../shared/principal.cjs', '../services-shared/principal.cjs']) {
    try { return require(p); } catch { /* try next layout */ }
  }
  // Fail closed if the shared module is unresolvable: same markers, inline.
  return {
    isNonHumanPrincipal: (req) => !!(req && (req.mcpToken || (req.user && (
      req.user.agent_id || req.user.actor_type === 'agent' || req.user.actor_type === 'plugin' || req.user.actor_type === 'system' || req.user.agent_ops || req.user.attach_lease_id)))),
  };
}

function deriveActorType(req) {
  if (!req) return null;
  if (isNonHumanPrincipal(req)) return 'agent';
  if (req.service === true) return 'service';
  if (req.user) return 'human';
  return null;
}

module.exports = { deriveActorType, isNonHumanPrincipal };
