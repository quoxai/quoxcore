/**
 * 'vault.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const vault = {
  'vault.activity.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/activity`,
    tags: ['live-safe'],
  },
  // VAULT-INTEG P6: agent-credential-assignments (services/auth/routes/
  // agent-credentials.js) is NOT under the /vault/ namespace alias — the
  // real route already lives at this exact path, no server-side rewrite.
  'vault.agent-assignments.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/agent-credential-assignments`,
    tags: ['live-write'],
  },
  'vault.agent-assignments.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/agent-credential-assignments/${id}`,
    tags: ['live-write'],
  },
  'vault.agent-assignments.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/agent-credential-assignments`,
    tags: ['live-safe'],
  },
  'vault.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault`,
    tags: ['live-write'],
  },
  'vault.cross-org.list': {
    method: 'GET',
    service: 'auth',
    // VAULT-INTEG P6: /me/cross-org-credentials — no orgId in the path at
    // all (it looks up every org the CALLER belongs to), so this is the one
    // vault.* entry with no {orgId} param.
    path: () => '/api/me/cross-org-credentials',
    tags: ['live-safe'],
  },
  'vault.default': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/vault/${id}/default`,
    tags: ['live-write'],
  },
  'vault.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/vault/${id}`,
    tags: ['live-write'],
  },
  'vault.expiring.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/expiring`,
    tags: ['live-safe'],
  },
  'vault.folders.create': {
    method: 'POST',
    service: 'auth',
    // Rewritten server-side: /orgs/:orgId/vault/folders -> /orgs/:orgId/credential-folders
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/folders`,
    tags: ['live-write'],
  },
  'vault.folders.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, folderId }) => `/api/orgs/${orgId}/vault/folders/${folderId}`,
    tags: ['live-write'],
  },
  'vault.folders.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/folders`,
    tags: ['live-safe'],
  },
  'vault.folders.update': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, folderId }) => `/api/orgs/${orgId}/vault/folders/${folderId}`,
    tags: ['live-write'],
  },
  'vault.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/vault/${id}`,
    tags: ['live-safe'],
  },
  // VAULT-INTEG P6: GET /internal/vault-health — service-key gated (checks
  // raw `x-service-key` header against INTERNAL_SERVICE_KEY), NOT a user
  // Bearer route. No orgId path param; org scoping is an optional query
  // string (`org_id`, server default 'default'). See vault.js's `vault
  // health` command doc comment for the auth caveat.
  'vault.health': {
    method: 'GET',
    service: 'auth',
    path: () => '/api/internal/vault-health',
    tags: ['skip-live'],
  },
  'vault.health-scan': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/health-scan`,
    tags: ['live-write'],
  },
  'vault.leases.approve': {
    method: 'POST',
    service: 'auth',
    // Rewritten server-side: /orgs/:orgId/vault/leases/... -> /orgs/:orgId/integrations/leases/...
    path: ({ orgId, leaseId }) => `/api/orgs/${orgId}/vault/leases/${leaseId}/approve`,
    tags: ['live-write'],
  },
  'vault.leases.deny': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, leaseId }) => `/api/orgs/${orgId}/vault/leases/${leaseId}/deny`,
    tags: ['live-write'],
  },
  'vault.leases.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/leases`,
    tags: ['live-safe'],
  },
  'vault.leases.request': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/leases/request`,
    tags: ['live-write'],
  },
  'vault.leases.revoke': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, leaseId }) => `/api/orgs/${orgId}/vault/leases/${leaseId}/revoke`,
    tags: ['live-write'],
  },
  'vault.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault`,
    tags: ['live-safe'],
  },
  'vault.rotate': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, id, testQuery }) => `/api/orgs/${orgId}/vault/${id}/rotate${testQuery}`,
    tags: ['live-write'],
  },
  'vault.test': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/vault/${id}/test`,
    tags: ['live-write'],
  },
  // VAULT-INTEG P6: POST /integrations/test-credentials — pre-save test,
  // nothing is persisted either way. Rewritten server-side the same as
  // every other /vault/* alias.
  'vault.test-credentials': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/test-credentials`,
    tags: ['live-write'],
  },
  'vault.types.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/types`,
    tags: ['live-safe'],
  },
  'vault.update': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, id }) => `/api/orgs/${orgId}/vault/${id}`,
    tags: ['live-write'],
  },
  'vault.vault-stats.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/vault/vault-stats`,
    tags: ['live-safe'],
  },
};
