/**
 * QUOXTRUST WP3.4b (2026-09-28) — resident identities get a GOVERNED tool
 * authorization surface.
 *
 * Closing the unknown-agent RBAC fallback (collector WP1.4) exposed a real
 * product gap: resident/attached identities (resident_identities rows, JWT
 * agent_id claim = users-row ULID) had NO path to tool authorization at all —
 * the agents-table-only resolution 404'd both the assignment write and the
 * collector's assignment lookup, so residents had silently depended on the
 * fail-open fallback. The fix is DATA-shaped, not another fallback: residents
 * become assignable principals in agent_tool_assignments, and get tools ONLY
 * by explicit assignment, exactly like custom agents.
 *
 * Key normalization: the collector lowercases ctx.agentId before its
 * assignment lookup (agentKey), while resident user_ids are uppercase ULIDs —
 * so the ASSIGNMENT KEY for a resident is always the LOWERCASED user_id, and
 * resolution here is case-insensitive. Only ACTIVE residents resolve; a
 * revoked resident loses its assignment surface with its identity.
 */
/**
 * Resolve an ACTIVE resident identity to its canonical assignment key.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} orgId  org scope, or null for the internal (cross-org) lookup
 * @param {string} candidateId the id the caller presented (any case)
 * @returns {{ assignmentKey: string, orgId: string } | null}
 */
export function resolveResidentAssignmentKey(db, orgId, candidateId) {
  if (!db || !candidateId || typeof candidateId !== 'string') return null;
  const row = orgId
    ? db.prepare(`
        SELECT user_id, org_id FROM resident_identities
        WHERE org_id = ? AND status = 'active'
          AND (user_id = ? OR user_id = upper(?) OR user_id = lower(?))
        LIMIT 1
      `).get(orgId, candidateId, candidateId, candidateId)
    : db.prepare(`
        SELECT user_id, org_id FROM resident_identities
        WHERE status = 'active'
          AND (user_id = ? OR user_id = upper(?) OR user_id = lower(?))
        LIMIT 1
      `).get(candidateId, candidateId, candidateId);
  if (!row) return null;
  return { assignmentKey: String(row.user_id).toLowerCase(), orgId: row.org_id };
}
