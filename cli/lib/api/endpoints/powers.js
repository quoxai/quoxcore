/**
 * 'powers.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const powers = {
  // Powers (WP2.1, auth/routes/powers.js) — org-scoped MCP tool deploys.
  // The whole deploy pipeline (detect/deploy/deploy-repo/finalize/update/
  // archive/restore/config/delete) is tagged skip-live: deploy-repo kicks
  // off a REAL powers-host container build, finalize/archive/restore/config
  // mutate that real deployed resource, and detect/deploy call out to a live
  // MCP URL — none of this is safe to fire unattended against a live stack.
  // Only the build-status GET is a pure read (live-safe).
  'powers.deploy': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/powers/deploy`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/powers/deploy/repo`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.archive': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/archive`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.config': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/config`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.finalize': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/finalize`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.restore': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/restore`,
    tags: ['skip-live'],
  },
  'powers.deploy-repo.status': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/status`,
    tags: ['live-safe'],
  },
  'powers.deploy-repo.update': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, toolDefId }) => `/api/orgs/${orgId}/powers/deploy/repo/${toolDefId}/update`,
    tags: ['skip-live'],
  },
  'powers.detect': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/powers/detect`,
    tags: ['skip-live'],
  },
};
