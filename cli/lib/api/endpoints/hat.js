/**
 * 'hat.*' endpoints (QUOXHAT #721 b): read-only views of the org's hats.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 *
 * Backend: services/auth/routes/quoxhat.js, mounted at plain `/api` on the
 * auth service; every route applies requireAuth + requireOrgMembership.
 * The collector holds only the /internal service-key hat routes, so the
 * user-facing reads live on auth (same as the dashboard's quoxhatClient).
 *
 * - list returns `{ hats: [...hat with definition], settings }`; listing
 *   also lazily installs/upgrades built-in templates (audited).
 * - get returns `{ hat, enforcement }`; `hat.revisions` is the history and
 *   `?revision=n` swaps in that revision's definition (`hat.revision_shown`).
 */

export const hat = {
  'hat.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/quoxhat/hats`,
    tags: ['live-safe'],
  },
  'hat.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, hatId }) => `/api/orgs/${orgId}/quoxhat/hats/${encodeURIComponent(hatId)}`,
    tags: ['live-safe'],
  },
  // Audited reset of an org-edited built-in hat back to its current template
  // (needs org manage-settings); writes quoxhat.hat.reset_to_template.
  'hat.reset': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, hatId }) => `/api/orgs/${orgId}/quoxhat/hats/${encodeURIComponent(hatId)}/reset-to-template`,
  },
};
