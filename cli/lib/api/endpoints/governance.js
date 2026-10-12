/**
 * 'governance.*' endpoints — OPGOV quox#582: the governance compiler's
 * draft-review-arm flow on the collector. Compile is deterministic
 * (lib/governance/ruleCompiler.js); arming requires a logged-in human, so a
 * service-key session can compile and list but never arm. Enforcement is
 * phase 3 and NOT wired yet; nothing here claims otherwise.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const governance = {
  // Pre-existing incident endpoints (from the monolithic endpoints.js split).
  'governance.incidents.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/governance/incidents/${id}`,
    tags: ['live-safe'],
  },
  'governance.incidents.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/governance/incidents`,
    tags: ['live-safe'],
  },
  'governance.policy.compile': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/governance/policies/compile`,
  },
  'governance.policy.list': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/governance/policies${p.state ? `?state=${encodeURIComponent(p.state)}` : ''}`,
    tags: ['live-safe'],
  },
  'governance.policy.arm': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/governance/policies/${p.id}/arm`,
  },
};

export default governance;
