/**
 * 'v1.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const v1 = {
  // QUOXON E1: what this Quox can do for the caller's org (installed |
  // requires_setup | unavailable | planned), from real health, licence,
  // install and provider signals. Org comes from the token.
  'v1.capabilities': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/capabilities`,
    tags: ['live-safe'],
  },
  'v1.settings.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/platform/settings/flags`,
    tags: ['live-safe'],
  },
  'v1.settings.set': {
    method: 'PATCH',
    service: 'collector',
    path: ({ key }) => `/api/v1/platform/settings/flags/${encodeURIComponent(key)}`,
    tags: ['live-write'],
  },
  'v1.settings.history': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/platform/settings/flags/history`,
    tags: ['live-safe'],
  },
  'v1.agents.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/agents`,
    tags: ['live-safe'],
  },
  'v1.fleet.status.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/fleet/status`,
    tags: ['live-safe'],
  },
  'v1.fleet.summary.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/fleet/summary`,
    tags: ['live-safe'],
  },
  // quox#460 — proxies Bastion's own host registry (GET /api/v1/hosts on
  // gw-01:9850), NOT the quoxagent heartbeat set fleet/status|summary|
  // agents.list count. Bastion knows hosts with no agent installed too.
  'v1.fleet.hosts.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/fleet/hosts`,
    tags: ['live-safe'],
  },
  // DEVSUITE-HUB Phase 2 — `quox dev enable` (see lib/commands/dev.js).
  // Constructs + signs + delivers a quoxagent dev.CapabilityProfile onto a
  // target host via Bastion. See services/collector/server.js's
  // POST /api/internal/dev-profiles/enable.
  // DEVSUITE phase 9 — `quox dev doctor` reads the registry to answer
  // "did the enable actually take on this host?".
  'v1.dev.servers.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/dev-servers`,
    tags: ['live-safe'],
  },
  'v1.dev.skills.status': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${hostId}/skill-pack-status`,
    tags: ['live-safe'],
  },
  'v1.dev.skills.sync': {
    method: 'POST',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${hostId}/skill-pack-sync`,
    tags: ['admin-write'],
  },
  // DEVSUITE-DEVMODE (quox#453 phase 15 follow-on), `quox dev supervisor`
  // (see lib/commands/devSupervisor.js). Read-only from the CLI: the switch
  // itself is admin-write, owned by a separate stream. This is the ONE
  // endpoint the headless runner polls to decide whether to run at all.
  'v1.dev.supervisor.get': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`,
    tags: ['live-safe'],
  },
  // QP-DASH P1: per-turn receipts (the invisible-churn fix). POST is the
  // runner reporting its own attempted turns; GET lists them with a summary.
  'v1.dev.supervisor.turns.record': {
    method: 'POST',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor/turns`,
    tags: ['live-write'],
  },
  'v1.dev.supervisor.turns.list': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor/turns`,
    tags: ['live-safe'],
  },
  // The write side. Gated server-side by requireHumanAdmin, so an org
  // owner/admin can flip it and a resident's own agent-scoped token cannot.
  // Added after quox#470 reported the switch as unreachable: the dashboard
  // toggle existed but there was no CLI verb, which fails the house rule
  // that nothing ships without CLI support.
  'v1.dev.supervisor.set': {
    method: 'PUT',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-servers/${encodeURIComponent(hostId)}/supervisor`,
    tags: ['admin-write'],
  },
  'v1.dev.profiles.enable': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/internal/dev-profiles/enable`,
    tags: ['live-write'],
  },
  // DEVSUITE-BUILD step 4 — `quox build` (see lib/commands/build.js).
  // dispatch names a PRE-REGISTERED target on the host; the collector signs
  // the envelope and the host-side executor (quoxagent dev.build) runs it.
  'v1.dev.build.dispatch': {
    method: 'POST',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-build/${encodeURIComponent(hostId)}/dispatch`,
    tags: ['live-write'],
  },
  'v1.dev.build.status': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-build/${encodeURIComponent(hostId)}/status`,
    tags: ['live-safe'],
  },
  'v1.dev.build.targets': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-build/${encodeURIComponent(hostId)}/targets`,
    tags: ['live-safe'],
  },
  // SLOTS-TMUX step B — `quox dev sessions` (see lib/commands/dev.js). The
  // interactive tmux path: quoxagent's dev.sessions methods had no caller
  // (note #2877); these five routes + verbs are the caller. The session
  // lives on the host's tmux server; every call here is one short signed
  // envelope delivery.
  'v1.dev.sessions.list': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-sessions/tmux/${encodeURIComponent(hostId)}`,
    tags: ['live-safe'],
  },
  'v1.dev.sessions.new': {
    method: 'POST',
    service: 'collector',
    path: ({ hostId }) => `/api/v1/dev-sessions/tmux/${encodeURIComponent(hostId)}`,
    tags: ['live-write'],
  },
  'v1.dev.sessions.keys': {
    method: 'POST',
    service: 'collector',
    path: ({ hostId, sessionId, byName }) => `/api/v1/dev-sessions/tmux/${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}/keys${byName ? '?by=name' : ''}`,
    tags: ['live-write'],
  },
  'v1.dev.sessions.pane': {
    method: 'GET',
    service: 'collector',
    path: ({ hostId, sessionId, byName }) => `/api/v1/dev-sessions/tmux/${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}/pane${byName ? '?by=name' : ''}`,
    tags: ['live-safe'],
  },
  'v1.dev.sessions.kill': {
    method: 'DELETE',
    service: 'collector',
    // by=name treats the identifier as the tmux session NAME: orphans
    // (sessions that survived an agent restart) have no session id.
    path: ({ hostId, sessionId, byName }) => `/api/v1/dev-sessions/tmux/${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}${byName ? '?by=name' : ''}`,
    tags: ['live-write'],
  },
  'v1.build.receipts.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/build-receipts`,
    tags: ['live-safe'],
  },
  'v1.build.status.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/build-status`,
    tags: ['live-safe'],
  },
  'v1.gpu.nodes.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/gpu/nodes`,
    tags: ['live-safe'],
  },
  'v1.health.aggregate.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/health/aggregate`,
    tags: ['live-safe'],
  },
  'v1.policies.approvals.pending.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/policies/approvals/pending`,
    tags: ['live-safe'],
  },
  'v1.policies.approvals.resolve': {
    method: 'POST',
    service: 'collector',
    path: ({ entryId }) => `/api/v1/policies/approvals/${entryId}/resolve`,
    tags: ['live-write'],
  },
  'v1.policies.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/policies`,
    tags: ['live-write'],
  },
  'v1.policies.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ id }) => `/api/v1/policies/${id}`,
    tags: ['live-write'],
  },
  'v1.policies.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/policies/${id}`,
    tags: ['live-safe'],
  },
  'v1.policies.history.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/policies/${id}/history`,
    tags: ['live-safe'],
  },
  'v1.policies.history.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/policies/history`,
    tags: ['live-safe'],
  },
  'v1.policies.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/policies`,
    tags: ['live-safe'],
  },
  'v1.policies.templates.conflicts': {
    method: 'POST',
    service: 'collector',
    path: ({ packId }) => `/api/v1/policies/templates/${packId}/conflicts`,
    tags: ['live-write'],
  },
  'v1.policies.templates.enable': {
    method: 'POST',
    service: 'collector',
    path: ({ packId }) => `/api/v1/policies/templates/${packId}/enable`,
    tags: ['live-write'],
  },
  'v1.policies.templates.get': {
    method: 'GET',
    service: 'collector',
    path: ({ packId }) => `/api/v1/policies/templates/${packId}`,
    tags: ['live-safe'],
  },
  'v1.policies.templates.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/policies/templates`,
    tags: ['live-safe'],
  },
  'v1.policies.update': {
    method: 'PATCH',
    service: 'collector',
    path: ({ id }) => `/api/v1/policies/${id}`,
    tags: ['live-write'],
  },
  'v1.policies.validate': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/policies/validate`,
    tags: ['live-write'],
  },
  'v1.tools.execute': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/tools/execute`,
    tags: ['live-write'],
  },
  // quox#791: stored outcome of an approved gated tool call.
  'v1.approvals.result': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/approvals/${encodeURIComponent(id)}/result`,
    tags: ['live-safe'],
  },
  // Fleet standing grants (2026-10-13): org-admin pre-approved ssh_exec lanes.
  'v1.approvals.grants.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/approvals/grants`,
    tags: ['live-safe'],
  },
  'v1.approvals.grants.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/approvals/grants`,
    tags: ['live-write'],
  },
  'v1.approvals.grants.revoke': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/approvals/grants/${encodeURIComponent(id)}/revoke`,
    tags: ['live-write'],
  },
  'v1.tools.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/tools/list`,
    tags: ['live-safe'],
  },
  // QUOXON-REACH: registered specialist roster (entity JSONs), used by `quox agent list`.
  'v1.agents.registry': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/agent-registry`,
    tags: ['live-safe'],
  },
  // DEVSUITE-GRIPE-P7 / quox#567 (CLI half): agent-to-tool permission
  // mapping, keyed by agent id (Object.keys(...).agentTools) — the
  // no-auth-gate source of truth for "which agent ids currently exist",
  // used by lib/core/agentAlias.js to resolve a display name (e.g. VULCAN)
  // to its registry id (forge) before any attach/exec call. Carries no
  // display names itself (see agentAlias.js for the bundled roster that
  // supplies those).
  'v1.tools.agents.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/tools/agents`,
    tags: ['live-safe'],
  },
  // DEVSUITE-SLOTS phase 5 — `quox slot` (see lib/commands/slot.js). The
  // list/checkout/release/heartbeat/create/retire routes were added in
  // phase 3; say/messages/inbound in phase 5 (see server.js ~5450-5640 and
  // devSlotsStore.js / devSlotMessagesStore.js).
  'v1.liveSessions.report': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/live-sessions/report`,
    tags: [],
  },
  'v1.liveSessions.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/live-sessions`,
    tags: ['live-safe'],
  },
  // QUOXON J1: one org-scoped index of live sessions + the wrapper heartbeat.
  'v1.sessions.index': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/sessions`,
    tags: ['live-safe'],
  },
  'v1.sessions.heartbeat': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/sessions/heartbeat`,
    tags: [],
  },
  'v1.sessions.end': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/sessions/end`,
    tags: [],
  },
  'v1.slots.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/slots`,
    tags: ['live-safe'],
  },
  'v1.slots.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/slots`,
    tags: ['live-write'],
  },
  'v1.slots.retire': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/slots`,
    tags: ['live-write'],
  },
  'v1.slots.prune': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/slots/prune`,
    tags: ['live-write'],
  },
  'v1.slots.checkout': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/checkout`,
    tags: ['live-write'],
  },
  'v1.slots.release': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/release`,
    tags: ['live-write'],
  },
  'v1.slots.heartbeat': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/heartbeat`,
    tags: ['live-write'],
  },
  // QUOX-CLAUDE-3 (quox#672): remote session control. POST is owner/admin
  // only (server decides); pending + ack are the slot keeper's (voice only).
  'v1.slots.control': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/control`,
    tags: ['live-write'],
  },
  'v1.slots.control.pending': {
    method: 'GET',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/control/pending`,
    tags: ['live-safe'],
  },
  'v1.slots.control.get': {
    method: 'GET',
    service: 'collector',
    path: ({ name, id }) => `/api/v1/slots/${encodeURIComponent(name)}/control/${encodeURIComponent(id)}`,
    tags: ['live-safe'],
  },
  'v1.slots.control.ack': {
    method: 'POST',
    service: 'collector',
    path: ({ name, id }) => `/api/v1/slots/${encodeURIComponent(name)}/control/${encodeURIComponent(id)}/ack`,
    tags: ['live-write'],
  },
  'v1.slots.say': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/say`,
    tags: ['live-write'],
  },
  'v1.slots.messages': {
    method: 'GET',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/messages`,
    tags: ['live-safe'],
  },
  // Long-poll for inbound slot messages; also heartbeats the hold when
  // holder_session is passed (see devSlotWait.js for the incident behind it).
  'v1.slots.wait': {
    method: 'GET',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/wait`,
    tags: ['live-safe'],
  },
  // "Option B" assign model (plan v2 note #2831): assign an expected holder
  // ahead of time, claim checks out every slot assigned to a session name.
  'v1.slots.assign': {
    method: 'POST',
    service: 'collector',
    path: ({ name }) => `/api/v1/slots/${encodeURIComponent(name)}/assign`,
    tags: ['live-write'],
  },
  'v1.slots.claim': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/slots/claim`,
    tags: ['live-write'],
  },
  // P10 SPLINTER-2: atomic per-message claim for members of a shared slot.
  'v1.slots.messageClaim': {
    method: 'POST',
    service: 'collector',
    path: ({ name, id }) => `/api/v1/slots/${encodeURIComponent(name)}/messages/${encodeURIComponent(id)}/claim`,
    tags: ['live-write'],
  },
  // Phase 9 — governed, org-scoped bridge-room config (`quox slot bridge`),
  // replacing QUOX_SLOT_BRIDGE_ROOM / QUOX_SLOT_DISCORD_ROOM as the primary
  // source (see no-env-only-config in CLAUDE.md).
  'v1.slots.bridges.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/slots/bridges`,
    tags: ['live-safe'],
  },
  'v1.slots.bridges.set': {
    method: 'PUT',
    service: 'collector',
    path: ({ platform }) => `/api/v1/slots/bridges/${encodeURIComponent(platform)}`,
    tags: ['live-write'],
  },
  // BASTION-CRED: read/update a host in the Bastion registry through the
  // collector's governed Bastion proxy (role-scoped: a host PUT needs admin).
  // Used to link/clear a host's bootstrap_credential_id without a raw curl.
  'v1.fleet.host.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/bastion/proxy/hosts/${encodeURIComponent(id)}`,
    tags: ['live-safe'],
  },
  'v1.fleet.host.update': {
    method: 'PUT',
    service: 'collector',
    path: ({ id }) => `/api/v1/bastion/proxy/hosts/${encodeURIComponent(id)}`,
    tags: ['live-write'],
  },
};
