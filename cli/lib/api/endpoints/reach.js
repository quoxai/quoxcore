/**
 * 'reach.*' endpoints — an agent's governed blast radius (BLAST-RADIUS-P0/P1/P2).
 * Proxied straight through to the collector route:
 * services/collector/server.js: GET /orgs/:orgId/agents/:agentId/reach
 * (requireServiceOrUserAuth: JWT or service key).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const reach = {
  'reach.agent.get': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/agents/${p.agentId}/reach`,
    tags: ['live-safe'],
  },
  // BLAST-RADIUS-P4: predicted-vs-actual least-privilege report.
  // services/collector/server.js: GET /orgs/:orgId/agents/:agentId/reach/least-privilege
  'reach.agent.leastPrivilege': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/agents/${p.agentId}/reach/least-privilege${p.days ? `?days=${encodeURIComponent(p.days)}` : ''}`,
    tags: ['live-safe'],
  },
  // OPGOV quox#573: org-wide rollup of the same grant graph (the agent CMDB).
  // services/collector/server.js: GET /orgs/:orgId/inventory
  // OPGOV quox#573 phase 3: witnessed drift vs the last stored snapshot.
  // services/collector/server.js: GET /orgs/:orgId/inventory/drift
  'reach.org.inventory.drift': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/orgs/${p.orgId}/inventory/drift`,
  },
  'reach.org.inventory': {
    method: 'GET',
    service: 'collector',
    path: (p) => {
      const q = [];
      if (p.days) q.push(`days=${encodeURIComponent(p.days)}`);
      if (p.unused === true) q.push('unused=true');
      return `/orgs/${p.orgId}/inventory${q.length ? `?${q.join('&')}` : ''}`;
    },
    tags: ['live-safe'],
  },
};

export default reach;
