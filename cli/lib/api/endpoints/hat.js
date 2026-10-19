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
  // quox#1183: which hat a conversation is on, and the person's own switch (audited quoxhat.binding.selected).
  'hat.resolve': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/quoxhat/resolve`,
    tags: ['live-safe'],
  },
  'hat.bind': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, conversationId }) => `/api/orgs/${orgId}/quoxhat/bindings/${encodeURIComponent(conversationId)}`,
  },
  // CUSTOM-HATS (owner 2026-10-17): create / edit (definition + optional rename) / delete a custom
  // hat. Same auth routes the dashboard uses; org hats need org manage-settings, a private hat only
  // its owner. Every write is revisioned and audited server-side (quoxhat.hat.created|updated|deleted).
  'hat.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/quoxhat/hats`,
  },
  'hat.update': {
    method: 'PUT',
    service: 'auth',
    path: ({ orgId, hatId }) => `/api/orgs/${orgId}/quoxhat/hats/${encodeURIComponent(hatId)}`,
  },
  'hat.delete': {
    method: 'DELETE',
    service: 'auth',
    path: ({ orgId, hatId }) => `/api/orgs/${orgId}/quoxhat/hats/${encodeURIComponent(hatId)}`,
  },
  // Audited reset of an org-edited built-in hat back to its current template
  // (needs org manage-settings); writes quoxhat.hat.reset_to_template.
  'hat.reset': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, hatId }) => `/api/orgs/${orgId}/quoxhat/hats/${encodeURIComponent(hatId)}/reset-to-template`,
  },
};
