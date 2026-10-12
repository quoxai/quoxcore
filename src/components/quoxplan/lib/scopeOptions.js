/**
 * Normalises the auth service's org scope tree (services/auth/routes/scopes.js
 * GET /orgs/:orgId/scopes?flat=true, proxied at collector
 * /api/v1/quoxplan-meta/scopes) into the QuoxPlan scope selector's option
 * list.
 *
 * Only division/department scopes are filter targets — the org-level root
 * scope is represented by the selector's own "All scopes" default, not a
 * list entry. Options are sorted by depth then name so divisions group
 * before their departments. The `name` here is the exact string written to
 * (and matched against) a stream's `assignee_scope` — QuoxPlan has no FK to
 * the scopes table, `assignee_scope` is a free string field, so the scope's
 * readable name IS the filter value.
 */
export function buildScopeOptions(scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes
    .filter((s) => s && (s.scope_type === 'division' || s.scope_type === 'department') && (s.name_cache || s.name))
    .map((s) => ({ id: s.id, name: s.name_cache || s.name, depth: s.depth ?? 0, type: s.scope_type }))
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
}
