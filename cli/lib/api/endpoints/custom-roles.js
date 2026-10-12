/**
 * 'custom-roles.*' endpoints — WP3.1 (docs/STREAM_CLI_PARITY_PLAN.md §2.3 #6).
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/customRoles.js, mounted at plain `/api`
 * (server.js:578 `app.use('/api', customRolesRoutes)`) — org-scoped IN the
 * URL (`/api/orgs/:orgId/custom-roles...`). Gated enterprise-tier +
 * ORG_MANAGE_ROLES. Verified at the handler: every route resolves the role
 * through `getCustomRole(db, req.org.id, roleId)` first, so a roleId from
 * another org 404s rather than leaking; no cross-tenant read/write path.
 *
 * The capabilities/agents/tools DELETE routes take their identifying
 * fields (`capability`/`agent_id`/`tool_id`, plus optional `scope_id`) as
 * EITHER query params or a body field (`req.query.x || req.body?.x`,
 * customRoles.js:199,246,283) — we send them as query params here to match
 * the other DELETE-with-filter routes in this CLI (e.g. plugins.data.delete).
 */

export const customRoles = {
  'custom-roles.agents.clear': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/agents`,
    tags: ['live-write'],
  },
  'custom-roles.agents.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/agents`,
    tags: ['live-safe'],
  },
  'custom-roles.agents.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/agents`,
    tags: ['live-write'],
  },
  'custom-roles.capabilities.add': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/capabilities`,
    tags: ['live-write'],
  },
  'custom-roles.capabilities.remove': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/capabilities`,
    tags: ['live-write'],
  },
  'custom-roles.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/custom-roles`,
    tags: ['live-write'],
  },
  'custom-roles.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}`,
    tags: ['live-write'],
  },
  'custom-roles.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}`,
    tags: ['live-safe'],
  },
  'custom-roles.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/custom-roles`,
    tags: ['live-safe'],
  },
  'custom-roles.tools.clear': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/tools`,
    tags: ['live-write'],
  },
  'custom-roles.tools.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/tools`,
    tags: ['live-safe'],
  },
  'custom-roles.tools.set': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, roleId }) => `/api/orgs/${orgId}/custom-roles/${roleId}/tools`,
    tags: ['live-write'],
  },
};
