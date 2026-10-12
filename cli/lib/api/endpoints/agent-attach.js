/**
 * 'agent-attach.*' endpoints — QUOXIDENTITY P1 (docs/QUOXIDENTITY_P1_CONTRACT.md,
 * territory C). Lease lifecycle lives on the auth service (services/auth,
 * territory A); the attach kit is served by the collector (services/collector,
 * territory B) and is fetched with the short-TTL attach JWT, not the caller's
 * normal session token.
 *
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const agentAttach = {
  'agent-attach.lease.create': {
    method: 'POST',
    service: 'auth',
    path: ({ agentId }) => `/api/agent-attach/${encodeURIComponent(agentId)}/lease`,
    tags: ['live-write'],
  },
  'agent-attach.lease.heartbeat': {
    method: 'POST',
    service: 'auth',
    path: ({ leaseId }) => `/api/agent-attach/lease/${encodeURIComponent(leaseId)}/heartbeat`,
    tags: ['live-write'],
  },
  'agent-attach.lease.release': {
    method: 'POST',
    service: 'auth',
    path: ({ leaseId }) => `/api/agent-attach/lease/${encodeURIComponent(leaseId)}/release`,
    tags: ['live-write'],
  },
  'agent-attach.status': {
    method: 'GET',
    service: 'auth',
    path: ({ agentId }) => `/api/agent-attach/${encodeURIComponent(agentId)}/status`,
    tags: ['live-safe'],
  },
  // P1 grant model (owner decision: per-agent grant, default owner-only). The
  // auth routes exist server-side; these fragments + the grant/revoke/list
  // verbs are what make them reachable. Org owner/admin only.
  'agent-attach.grants.add': {
    method: 'POST',
    service: 'auth',
    path: ({ agentId }) => `/api/agent-attach/${encodeURIComponent(agentId)}/grants`,
    tags: ['live-write'],
  },
  'agent-attach.grants.remove': {
    method: 'DELETE',
    service: 'auth',
    path: ({ agentId, granteeUserId }) =>
      `/api/agent-attach/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(granteeUserId)}`,
    tags: ['live-write'],
  },
  'agent-attach.grants.list': {
    method: 'GET',
    service: 'auth',
    path: ({ agentId }) => `/api/agent-attach/${encodeURIComponent(agentId)}/grants`,
    tags: ['live-safe'],
  },
  // QUOXIDENTITY P10: roster-wide (attach-any) grant. Org owner/admin only.
  'agent-attach.grants.add-all': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/agent-attach/grants/all`,
    tags: ['live-write'],
  },
  'agent-attach.grants.remove-all': {
    method: 'DELETE',
    service: 'auth',
    path: ({ granteeUserId }) => `/api/agent-attach/grants/all/${encodeURIComponent(granteeUserId)}`,
    tags: ['live-write'],
  },
  // Served by the collector, not auth: the kit is fetched with the attach
  // JWT (Authorization header set explicitly by the caller via noAuth+headers),
  // never the caller's own session token.
  'agent-attach.kit': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/agent-attach/kit`,
    tags: ['live-safe'],
  },
  // P2 (docs/QUOXIDENTITY_P2_CONTRACT.md, territory D/E): stores a handoff
  // note before the CLI releases the lease, so the next session attached to
  // this agent resumes with continuity. Same gate shape as the kit route:
  // attach-lease-bearing callers only, authenticated with the attach JWT.
  'agent-attach.handoff': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/agent-attach/handoff`,
    tags: ['live-write'],
  },
  // P4 (docs/QUOXIDENTITY_P4_CONTRACT.md §5): detach witnessing symmetry.
  // Witness-only: does NOT release the lease (auth, territory A, owns lease
  // state). Same gate shape as the kit/handoff routes: attach-lease-bearing
  // callers only, authenticated with the attach JWT. The CLI posts this
  // between releasing a checked-out slot and releasing the lease.
  'agent-attach.detach': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/agent-attach/detach`,
    tags: ['live-write'],
  },
  // P3 (docs/QUOXIDENTITY_P3_CONTRACT.md, territory F/G): binding an agent
  // identity to a durable slot ADDRESS (dev_slots row). Served by the
  // collector next to the kit route, same auth gate pattern. PUT/DELETE are
  // org admin only (binding an address is an admin act); GET is open to any
  // org member or an attach-token caller. Slot HTTP shapes themselves
  // (checkout/release/say/etc.) are NOT duplicated here: the CLI reuses
  // v1.slots.* from ./v1.js for those.
  'agent-attach.slot-binding.set': {
    method: 'PUT',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/agent-attach/${encodeURIComponent(agentId)}/slot-binding`,
    tags: ['live-write'],
  },
  'agent-attach.slot-binding.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/agent-attach/${encodeURIComponent(agentId)}/slot-binding`,
    tags: ['live-write'],
  },
  'agent-attach.slot-binding.get': {
    method: 'GET',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/agent-attach/${encodeURIComponent(agentId)}/slot-binding`,
    tags: ['live-safe'],
  },
};
