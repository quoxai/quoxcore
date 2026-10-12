/**
 * matrixProvisioner.js, M-ROOMS #191 Phase 1: room provisioning orchestration.
 *
 * The auth service is the ONE brain for default Matrix room provisioning
 * (docs/STREAM_M_ROOMS_PLAN.md section 2.4). Given an org-tree node this
 * module computes:
 *   - the canonical room alias (stable-id derived, idempotency belt one),
 *   - the ai.quox.room v2 state payload (plus the legacy ai.quox.org event
 *     for back-compat with roomOrg.js / witnessBridge.js consumers),
 *   - the membership set per the scoped access model: the node's own members
 *     plus the three admin tiers (org / division / department) walking
 *     scopes.path downward-within-subtree,
 * and records the result in the matrix_rooms ledger (082-matrix-rooms.sql,
 * idempotency belt two: UNIQUE(org_id, node_type, node_id)).
 *
 * The actual Matrix-side plumbing (createRoom, state events, invites) lives
 * behind the appservice's POST /internal/provision endpoint (quox-matrix,
 * appservice/src/provision.js). callAppserviceProvision() below POSTs the
 * computed instruction there, service-key authenticated, fail-soft: any
 * failure logs and returns null, the ledger row stays 'pending', and the
 * backfill sweep retries. Node creation is never broken by a Matrix outage.
 * The call is only enabled when MATRIX_APPSERVICE_URL is configured.
 *
 * Membership model notes (scope-gated by construction, plan 2.1a / 2.5):
 *   - A node room's scoped members are the active members of the scope's
 *     attached auto-team (teams.attach_scope_id = scope.id). This holds at
 *     org level too: the org room is the org-scoped seat, NOT an all-hands
 *     room, so a department-only user is provably NOT in the org room
 *     (Phase 1 done-means, plan section 4). Org admins are always present
 *     via the admin tiers below.
 *   - Admin tiers walk UP the room node's ancestor chain: org admins
 *     (org_memberships.role owner/admin) are in every room of the org;
 *     a division or department admin (team_memberships.role='admin' on that
 *     scope's attached team) is in every room whose path contains their node.
 *     Upward is always closed; admin only widens reach downward.
 *   - CommanderQ (`quox`) gets one per-tenant room, org admins only. It is
 *     never joined into any scoped node room.
 *   - Auto-created attached teams do NOT get their own room: the node room
 *     IS the scope's attached team room (plan decision 7 lean). Standalone
 *     user-created teams get their own room.
 *   - agentic_team nodes are AI-only rosters (no scope row, per
 *     082-matrix-rooms.sql). Their room invites the team's full agent
 *     roster, orchestrator plus members (resolveTeamRoster), instead of the
 *     single scope assistant every other node type gets.
 *   - dev_slot nodes (DEVSUITE-SLOTS #456 phase 4) are the collector's
 *     durable session-slot addresses (node_id = collector dev_slots.id, a
 *     different database from this one; auth never reads that table
 *     directly, the collector is the only caller). No scope row, same
 *     no-scope membership as agentic_team/quoxchat (org admins + the acting
 *     user, if any). default_agent is always the core agent 'quox' so
 *     @mentions in a slot room resolve even when no session holds the slot.
 */

import { getDb, prepare } from '../db/index.js';
import { ulid, createAuditEvent } from '../utils/helpers.js';
import { getScopeForEntity, getScopeById, getScopeAncestors } from '../utils/scopes.js';
import { readInstanceConfigValue } from './instanceConfigOverrides.js';
import { getSetting } from './configResolver.js';

export const PROVISIONABLE_NODE_TYPES = ['org', 'division', 'department', 'team', 'agentic_team', 'quoxchat', 'dev_slot'];

/**
 * QUOXCHAT-PRO visitor name: word-safe short id for a label fallback —
 * same rule as the collector's quoxchatMatrixRelay.shortVisitorLabel
 * (last token whole when it is a word, last 6 chars when it is a random
 * id) so "proof-visitor" never renders as "isitor".
 */
function shortNodeLabel(id) {
    const raw = String(id || '').trim();
    if (!raw) return 'anon';
    const tokens = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (tokens.length === 0) return 'anon';
    const last = tokens[tokens.length - 1];
    if (/^[a-zA-Z]+$/.test(last)) return last.slice(0, 12).toLowerCase();
    return last.slice(-6).toLowerCase();
}
export const COMMANDERQ_NODE_ID = 'commanderq';
export const COMMANDERQ_AGENT_ID = 'quox';

// VAULT-INTEG P17: instance_config ('matrix_server_name', written by the
// setup wizard) wins over MATRIX_SERVER_NAME when set.
function serverName() {
    return readInstanceConfigValue('matrix_server_name') || process.env.MATRIX_SERVER_NAME || 'quox';
}

/** Exported for other auth-owned Matrix consumers (routes/matrix-sso.js). */
export function resolveMatrixServerName() {
    return serverName();
}

/**
 * M-ISO #209 feature flag: per-(user, org) Matrix identities. When on, every
 * human Matrix id is org-suffixed (`@human.<userId>.<orgId>:server`) so one
 * Quox user holds a distinct Matrix account per org and Matrix-side room
 * membership becomes real org isolation. Off (default) keeps the legacy
 * shared identity `@human.<userId>:server`.
 */
export function perOrgIdentityEnabled() {
    const v = String(process.env.MATRIX_PER_ORG_IDENTITY || '').toLowerCase();
    return v === '1' || v === 'true';
}

// VAULT-INTEG P17: MATRIX_ROOMS was a bare `process.env.MATRIX_ROOMS !==
// 'off'` check repeated at 8 call sites across routes/orgs.js,
// routes/divisions.js, routes/teams.js, routes/departments.js — none of
// them consulted a stored org override (platformCapabilities.js;
// registered as a kill-flag, `offOnlyWhen: 'off'`, same semantics this
// function preserves). Resolved fresh on every call via
// configResolver.getSetting() (org-scoped: eager Matrix room provisioning
// is a per-org choice, made on every org/division/team/department
// create-or-delete request — a stored override applies to the very next
// one, no restart needed). Fail-safe: any resolver failure (no service
// key, network error, no override stored) falls back to the plain env
// check every call site used before this pass.
export async function isMatrixRoomsEnabled(orgId, deps = {}) {
    try {
        const resolved = await getSetting(orgId, 'MATRIX_ROOMS', deps);
        if (resolved && typeof resolved.on === 'boolean') return resolved.on;
    } catch (err) {
        console.error(`[MatrixRooms] MATRIX_ROOMS resolver failed for org=${orgId}, falling back to env — ${err.message}`);
    }
    return process.env.MATRIX_ROOMS !== 'off';
}

function nowIso() {
    return new Date().toISOString();
}

/**
 * Canonical room alias for a node: #qx_<org8>_<node_type>_<node8>:<server>.
 * First 8 chars of each ULID, lowercased (Matrix alias localparts are
 * conventionally lowercase). If a ledger row for a DIFFERENT node already
 * holds the alias (8-char prefix collision), the prefixes are lengthened
 * until unique; the ledger's unique alias index is the collision check at
 * full length the plan calls for.
 *
 * @param {string} orgId
 * @param {string} nodeType
 * @param {string} nodeId
 * @returns {string} room alias
 */
export function computeRoomAlias(orgId, nodeType, nodeId) {
    const lengths = [8, 12, 16, 26];
    for (const len of lengths) {
        // CommanderQ is one-per-tenant: the org prefix alone identifies it.
        const alias = nodeType === COMMANDERQ_NODE_ID
            ? `#qx_${String(orgId).slice(0, len).toLowerCase()}_${COMMANDERQ_NODE_ID}:${serverName()}`
            : `#qx_${String(orgId).slice(0, len).toLowerCase()}_${nodeType}_${String(nodeId).slice(0, len).toLowerCase()}:${serverName()}`;
        const holder = prepare(
            'SELECT org_id, node_type, node_id FROM matrix_rooms WHERE room_alias = ?'
        ).get(alias);
        if (!holder) return alias;
        if (holder.org_id === orgId && holder.node_type === nodeType && holder.node_id === nodeId) {
            return alias; // our own existing row
        }
        // Prefix collision with another node: lengthen and retry.
    }
    // ULIDs are unique at full length; reaching here means duplicate ids.
    throw new Error(`Alias collision at full id length for ${nodeType}/${nodeId}`);
}

/**
 * Build the human-facing room label as a full org-hierarchy breadcrumb:
 * "Org > Division > Department" (root to leaf), not just the leaf name_cache.
 * Walks parent_scope_id up from the given scope, collecting name_cache at
 * each hop, then joins root-first. An org scope (no parent) is just the org
 * name. Cycle-guarded: a malformed parent chain stops after MAX_HOPS instead
 * of looping forever, returning whatever names it collected so far.
 *
 * @param {object} scope - full scopes row for the node (id, name_cache, parent_scope_id, ...)
 * @returns {string} breadcrumb label, e.g. "ExamplePools > Marketing > PayPerClick"
 */
function buildBreadcrumbLabel(scope) {
    const MAX_HOPS = 10;
    const names = [scope.name_cache];
    let parentId = scope.parent_scope_id;
    let hops = 0;
    while (parentId && hops < MAX_HOPS) {
        const parent = prepare(
            'SELECT parent_scope_id, name_cache, scope_type FROM scopes WHERE id = ?'
        ).get(parentId);
        if (!parent) break; // missing ancestor row: use what we have
        names.unshift(parent.name_cache);
        parentId = parent.parent_scope_id;
        hops++;
    }
    return names.join(' > ');
}

/**
 * Resolve an org's display name for the CommanderQ room label. Prefers the
 * org scope's name_cache (the same source buildBreadcrumbLabel walks to),
 * falling back to the orgs table if the org scope row is missing.
 *
 * @param {string} orgId
 * @returns {string} org display name, or the raw orgId if nothing is found
 */
function resolveOrgName(orgId) {
    const orgScope = prepare(
        "SELECT name_cache FROM scopes WHERE org_id = ? AND scope_type = 'org'"
    ).get(orgId);
    if (orgScope && orgScope.name_cache) return orgScope.name_cache;
    const org = prepare('SELECT name FROM orgs WHERE id = ?').get(orgId);
    if (org && org.name) return org.name;
    return orgId;
}

/**
 * Resolve the node's default assistant: the assistants row homed on this
 * scope (created eagerly at node creation / by backfill-scope-assistants).
 *
 * @param {string|null} scopeId
 * @returns {string|null} assistants.id or null (e.g. a team with no assistant)
 */
export function resolveDefaultAgent(scopeId) {
    if (!scopeId) return null;
    const row = prepare(
        "SELECT id FROM assistants WHERE home_scope_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1"
    ).get(scopeId);
    return row ? row.id : null;
}

/**
 * Resolve the full agent roster for an agentic_team node room: the
 * orchestrator agent (agents.agent_id = 'team-<teamId>', the convention
 * routes/teamAssistants.js uses when a custom team is created) plus any
 * member agents registered under it (agents.parent_agent_id pointing at the
 * orchestrator's row, the existing "reports to" hierarchy column already on
 * the agents table). This is the one roster auth's own database can answer
 * directly today: the team's full manifest (members[], policies) lives in
 * the tasks service's team_definitions table, and auth has no service-key
 * authed endpoint to read it from there. Deduplicated by construction.
 *
 * Fail-soft by contract: any lookup problem (including no orchestrator row
 * found at all, e.g. a team never wired through teamAssistants.js) is
 * caught, logged, and null returned, so the caller falls back to the
 * existing single default_agent behaviour instead of throwing.
 *
 * @param {string} orgId
 * @param {string} teamId - agentic_team node id (matches the team-<teamId> convention)
 * @returns {{ orchestratorAgentId: string, memberAgentIds: string[], allAgentIds: string[] }|null}
 */
export function resolveTeamRoster(orgId, teamId) {
    try {
        const orchestrator = prepare(
            "SELECT id, agent_id FROM agents WHERE org_id = ? AND agent_id = ? AND status = 'active'"
        ).get(orgId, `team-${teamId}`);
        if (!orchestrator) return null;

        const members = prepare(
            "SELECT agent_id FROM agents WHERE org_id = ? AND parent_agent_id = ? AND status = 'active'"
        ).all(orgId, orchestrator.id);

        const allAgentIds = [...new Set([orchestrator.agent_id, ...members.map((m) => m.agent_id)])];
        return {
            orchestratorAgentId: orchestrator.agent_id,
            memberAgentIds: allAgentIds.filter((id) => id !== orchestrator.agent_id),
            allAgentIds,
        };
    } catch (err) {
        console.warn(`[matrixProvisioner] resolveTeamRoster failed for agentic_team ${teamId}: ${err.message}`);
        return null;
    }
}

/**
 * Build the room state events for a node room: the ai.quox.room v2 event
 * (full node identity) plus the legacy ai.quox.org event so every current
 * consumer (roomOrg.js, witnessBridge.js) works unchanged on day one.
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {string} p.nodeType
 * @param {string} p.nodeId
 * @param {string|null} p.scopeId
 * @param {string|null} p.defaultAgent
 * @returns {{ 'ai.quox.room': object, 'ai.quox.org': object }}
 */
export function buildRoomState({ orgId, nodeType, nodeId, scopeId, defaultAgent }) {
    return {
        'ai.quox.room': {
            v: 2,
            org_id: orgId,
            node_type: nodeType,
            node_id: nodeId,
            scope_id: scopeId || null,
            default_agent: defaultAgent || null,
            provisioned_by: 'quox-provisioner',
            provisioned_at: nowIso(),
        },
        'ai.quox.org': { org_id: orgId },
    };
}

function orgAdminIds(orgId) {
    return prepare(
        "SELECT user_id FROM org_memberships WHERE org_id = ? AND status = 'active' AND role IN ('owner', 'admin')"
    ).all(orgId).map((r) => r.user_id);
}

function attachedTeamMemberIds(scopeId, orgId, { role = null } = {}) {
    const roleClause = role ? "AND tm.role = ?" : '';
    const params = role ? [scopeId, orgId, role] : [scopeId, orgId];
    return prepare(`
        SELECT tm.user_id FROM team_memberships tm
        JOIN teams t ON t.id = tm.team_id
        WHERE t.attach_scope_id = ? AND t.org_id = ? AND tm.status = 'active' ${roleClause}
    `).all(...params).map((r) => r.user_id);
}

function teamMemberIds(teamId) {
    return prepare(
        "SELECT user_id FROM team_memberships WHERE team_id = ? AND status = 'active'"
    ).all(teamId).map((r) => r.user_id);
}

/**
 * Compute the human membership set for a node room per the access model:
 * the node's own scoped members plus every admin whose node subtree contains
 * this room (walking the ancestor chain; org admins always).
 *
 * @param {object} scope - full scopes row for the node
 * @returns {{ humans: string[], admins: string[] }} deduped user ids;
 *   `admins` is the admin-tier subset of `humans` (useful for power levels
 *   later, plan Phase 7)
 */
export function computeMembership(scope) {
    const humans = new Set();
    const admins = new Set();

    // Scoped members: the members of this scope's own seat.
    if (scope.scope_type === 'team') {
        for (const id of teamMemberIds(scope.ref_id)) humans.add(id);
    } else {
        // org / division / department: the scope's attached auto-team.
        for (const id of attachedTeamMemberIds(scope.id, scope.org_id)) humans.add(id);
    }

    // Admin tiers, walking the ancestor chain (self included): an admin at
    // node S is a member of every room whose path contains S.
    for (const id of orgAdminIds(scope.org_id)) { humans.add(id); admins.add(id); }
    const chain = [...getScopeAncestors(scope.id), scope];
    for (const node of chain) {
        if (node.scope_type === 'division' || node.scope_type === 'department') {
            for (const id of attachedTeamMemberIds(node.id, scope.org_id, { role: 'admin' })) {
                humans.add(id);
                admins.add(id);
            }
        }
    }

    return { humans: [...humans], admins: [...admins] };
}

/**
 * Idempotent ledger write. Inserts a pending row if the node has none;
 * returns the existing row untouched otherwise. The UNIQUE(org_id,
 * node_type, node_id) constraint makes a racing double-insert lose cleanly.
 *
 * @returns {{ row: object, created: boolean }}
 */
export function ensureLedgerRow({ orgId, nodeType, nodeId, scopeId, roomAlias, defaultAgent }) {
    const existing = prepare(
        'SELECT * FROM matrix_rooms WHERE org_id = ? AND node_type = ? AND node_id = ?'
    ).get(orgId, nodeType, nodeId);
    if (existing) return { row: existing, created: false };

    const id = ulid();
    try {
        prepare(`
            INSERT INTO matrix_rooms (id, org_id, node_type, node_id, scope_id, room_alias, default_agent, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(id, orgId, nodeType, nodeId, scopeId || null, roomAlias, defaultAgent || null);
    } catch (err) {
        // Lost a race: the other writer's row is the record.
        if (/UNIQUE constraint failed/i.test(err.message)) {
            const winner = prepare(
                'SELECT * FROM matrix_rooms WHERE org_id = ? AND node_type = ? AND node_id = ?'
            ).get(orgId, nodeType, nodeId);
            if (winner) return { row: winner, created: false };
        }
        throw err;
    }
    const row = prepare('SELECT * FROM matrix_rooms WHERE id = ?').get(id);
    return { row, created: true };
}

function safeSegment(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9._=\-/]/g, '_');
}

/**
 * Matrix user id for a Quox human user. MUST stay in lockstep with
 * routes/matrix-sso.js toLocalpart(): the room invite has to hit the same
 * Matrix user the SSO JWT login mints, or the human never sees the room.
 *
 * M-ISO #209: when MATRIX_PER_ORG_IDENTITY is on AND an orgId is passed, the
 * id is the per-org identity `@human.<userId>.<orgId>:server`. Flag off, or
 * no orgId in hand, stays the legacy shared `@human.<userId>:server`.
 *
 * @param {string} userId - auth users.id (ULID)
 * @param {string} [orgId] - org context for the per-org identity
 * @returns {string} full Matrix user id, e.g. @human.01h...:quox
 */
export function humanMatrixUserId(userId, orgId) {
    const localpart = (perOrgIdentityEnabled() && orgId)
        ? `human.${safeSegment(userId)}.${safeSegment(orgId)}`
        : `human.${safeSegment(userId)}`;
    return `@${localpart}:${serverName()}`;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Agent LOCALPART id for the appservice (@_quoxagent_<localpart>). DB scope
 * assistants (ULID ids) are namespaced as a_<ulid lowercase> per plan section
 * 2.6; core agent ids ('quox', 'sentinel', ...) pass through lowercased.
 * The appservice enforces [a-z0-9_]+ so the namespacing happens HERE, on the
 * brain side, keeping the appservice free of id-classification logic.
 *
 * @param {string} agentId - assistants.id ULID or core agent id
 * @returns {string} localpart-safe agent id (no @_quoxagent_ prefix)
 */
export function agentLocalpart(agentId) {
    const id = String(agentId);
    return ULID_RE.test(id) ? `a_${id.toLowerCase()}` : id.toLowerCase();
}

/**
 * Appservice plumbing call (plan section 2.4): POST the provision instruction
 * to the quox-matrix appservice's /internal/provision endpoint, which does
 * createRoomAs (adopting the existing room on M_ROOM_IN_USE) +
 * sendStateEventAs (both ai.quox.room and legacy ai.quox.org) + inviteAs for
 * humans + register/join for agents, and returns { room_id, status, errors }.
 *
 * Auth: X-Service-Key = PROVISION_SERVICE_KEY, falling back to the shared
 * INTERNAL_SERVICE_KEY (the same secret the appservice uses for its collector
 * calls, so one .env value works across both compose projects).
 *
 * Fail-soft by contract: EVERY failure path (unconfigured, timeout, network,
 * non-2xx, malformed response) logs and returns null. Callers leave the
 * ledger row 'pending' and the backfill sweep retries; node creation never
 * breaks on Matrix trouble.
 *
 * @param {object} payload - { org_id, room_alias, name, topic, state,
 *   invite_users: [<auth user ids>], join_agents: [<agent/assistant ids>] }.
 *   org_id is the room's org context for per-org human identities (M-ISO
 *   #209); it is consumed by the invite mapping here and NOT forwarded to
 *   the appservice body.
 * @returns {Promise<{ room_id: string, status: string, errors: string[] }|null>}
 */
export async function callAppserviceProvision(payload) {
    const baseUrl = (process.env.MATRIX_APPSERVICE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) return null; // appservice not wired on this deployment; rows stay pending
    const serviceKey = process.env.PROVISION_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) {
        console.warn('[matrixProvisioner] MATRIX_APPSERVICE_URL set but no PROVISION_SERVICE_KEY/INTERNAL_SERVICE_KEY; skipping provision call');
        return null;
    }
    const timeoutMs = Number(process.env.MATRIX_PROVISION_TIMEOUT_MS) || 15000;

    const body = {
        room_alias: payload.room_alias,
        name: payload.name,
        topic: payload.topic,
        state: payload.state,
        // Auth ids -> Matrix ids at the boundary: the appservice stays thin
        // (it invites exactly the Matrix users it is handed, no mapping).
        // The room's org context rides along so flag-on deployments mint
        // per-org identities (M-ISO #209).
        invite_users: (payload.invite_users || []).map((id) => humanMatrixUserId(id, payload.org_id)),
        join_agents: (payload.join_agents || []).map(agentLocalpart),
    };

    try {
        const res = await fetch(`${baseUrl}/internal/provision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[matrixProvisioner] provision ${payload.room_alias} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
            return null;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.room_id) {
            console.error(`[matrixProvisioner] provision ${payload.room_alias}: appservice returned no room_id`);
            return null;
        }
        if (Array.isArray(data.errors) && data.errors.length) {
            // Partial success: the room exists (row can flip active) but some
            // member/state steps failed; the reconcile sweep re-diffs them.
            console.warn(`[matrixProvisioner] provision ${payload.room_alias} -> ${data.room_id} with ${data.errors.length} member/state error(s):`, data.errors);
        }
        return { room_id: data.room_id, status: data.status || 'created', errors: data.errors || [] };
    } catch (err) {
        console.error(`[matrixProvisioner] provision ${payload.room_alias} unreachable (${err.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : err.message}); row stays pending for the sweep`);
        return null;
    }
}

/**
 * Appservice plumbing call for teardown: POST { room_id } to the quox-matrix
 * appservice's /internal/deprovision endpoint. Same auth, timeout, and
 * fail-soft contract as callAppserviceProvision: any failure logs and
 * returns null so the caller leaves the ledger row untouched for a retry.
 *
 * @param {string} roomId - the Matrix room id to retire
 * @returns {Promise<boolean|null>} true on a 2xx response, null on any failure
 */
export async function callAppserviceDeprovision(roomId) {
    const baseUrl = (process.env.MATRIX_APPSERVICE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) return null; // appservice not wired on this deployment; row stays untouched
    const serviceKey = process.env.PROVISION_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) {
        console.warn('[matrixProvisioner] MATRIX_APPSERVICE_URL set but no PROVISION_SERVICE_KEY/INTERNAL_SERVICE_KEY, skipping deprovision call');
        return null;
    }
    const timeoutMs = Number(process.env.MATRIX_PROVISION_TIMEOUT_MS) || 15000;

    try {
        const res = await fetch(`${baseUrl}/internal/deprovision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
            body: JSON.stringify({ room_id: roomId }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[matrixProvisioner] deprovision ${roomId} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
            return null;
        }
        return true;
    } catch (err) {
        console.error(`[matrixProvisioner] deprovision ${roomId} unreachable (${err.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : err.message}), row stays active for a retry`);
        return null;
    }
}

/**
 * M-ISO #209 appservice plumbing call: POST { room_id, invite } to the
 * quox-matrix appservice's /internal/migrate-humans endpoint. The appservice
 * invites the given per-org MXIDs and kicks legacy-format humans itself (any
 * `@human.<seg>` member where seg has no dot); auth only supplies the new
 * invites. Same auth, timeout, and fail-soft contract as
 * callAppserviceProvision: any failure logs and returns null so the caller
 * can retry the room later.
 *
 * @param {string} roomId - the Matrix room id to migrate
 * @param {string[]} inviteMxids - full per-org Matrix user ids to invite
 * @returns {Promise<{ room_id: string, invited: any, kicked: any, errors: any[] }|null>}
 */
export async function callAppserviceMigrateHumans(roomId, inviteMxids) {
    const baseUrl = (process.env.MATRIX_APPSERVICE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) return null; // appservice not wired on this deployment
    const serviceKey = process.env.PROVISION_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) {
        console.warn('[matrixProvisioner] MATRIX_APPSERVICE_URL set but no PROVISION_SERVICE_KEY/INTERNAL_SERVICE_KEY, skipping migrate-humans call');
        return null;
    }
    const timeoutMs = Number(process.env.MATRIX_PROVISION_TIMEOUT_MS) || 15000;

    try {
        const res = await fetch(`${baseUrl}/internal/migrate-humans`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
            body: JSON.stringify({ room_id: roomId, invite: inviteMxids }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[matrixProvisioner] migrate-humans ${roomId} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
            return null;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.room_id) {
            console.error(`[matrixProvisioner] migrate-humans ${roomId}: appservice returned no room_id`);
            return null;
        }
        return data;
    } catch (err) {
        console.error(`[matrixProvisioner] migrate-humans ${roomId} unreachable (${err.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : err.message})`);
        return null;
    }
}

/**
 * M-ISO #209 migration sweep: walk every ACTIVE matrix_rooms row (optionally
 * one org's) and move its human membership from the legacy shared identities
 * to per-org identities. Per room the human set is recomputed exactly the
 * way provisioning computes it:
 *   - scoped rows (org/division/department/team with a scope_id):
 *     computeMembership on the row's scope,
 *   - agentic_team / commanderq / any row without a scope_id: orgAdminIds
 *     (the oversight tier; the original creating actor is not persisted on
 *     the ledger so it cannot be re-derived here),
 * then mapped to per-org MXIDs and POSTed to the appservice's
 * /internal/migrate-humans, which invites them and kicks the legacy
 * identities itself. Sequential and fail-soft per room: one bad room is
 * recorded in errors and the sweep continues; re-running is safe.
 *
 * Callers must gate on perOrgIdentityEnabled(): migrating while the flag is
 * off would kick the identities everyone is actively logged in with.
 *
 * @param {object} [opts]
 * @param {string} [opts.orgId] - restrict to one org (default: all orgs)
 * @returns {Promise<{ rooms: number, migrated: number, errors: string[] }>}
 */
export async function migrateRoomsToOrgIdentities({ orgId } = {}) {
    getDb();
    const rows = orgId
        ? prepare("SELECT * FROM matrix_rooms WHERE status = 'active' AND org_id = ?").all(orgId)
        : prepare("SELECT * FROM matrix_rooms WHERE status = 'active'").all();

    const errors = [];
    let migrated = 0;

    for (const row of rows) {
        const label = row.room_alias || row.room_id || row.id;
        try {
            if (!row.room_id) {
                errors.push(`${label}: active ledger row has no room_id`);
                continue;
            }

            let humanIds;
            if (row.node_type === 'agentic_team' || row.node_type === COMMANDERQ_NODE_ID || !row.scope_id) {
                humanIds = orgAdminIds(row.org_id);
            } else {
                const scope = getScopeById(row.scope_id);
                if (!scope) {
                    errors.push(`${label}: scope ${row.scope_id} not found`);
                    continue;
                }
                humanIds = computeMembership(scope).humans;
            }

            const invite = humanIds.map((id) => humanMatrixUserId(id, row.org_id));
            const result = await callAppserviceMigrateHumans(row.room_id, invite);
            if (!result) {
                errors.push(`${label}: appservice migrate-humans call failed`);
                continue;
            }
            migrated++;
            if (Array.isArray(result.errors) && result.errors.length) {
                errors.push(`${label}: ${result.errors.length} member error(s): ${result.errors.map(String).join('; ').slice(0, 300)}`);
            }
        } catch (err) {
            errors.push(`${label}: ${err.message}`);
        }
    }

    return { rooms: rows.length, migrated, errors };
}

/**
 * Provision (or adopt) the default room for one org-tree node. Idempotent:
 * a node with an active ledger row is a no-op; a pending/failed row is
 * retried against the (stubbed) appservice.
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {'org'|'division'|'department'|'team'|'agentic_team'|'quoxchat'|'dev_slot'} p.nodeType
 * @param {string} p.nodeId - the entity id (orgId itself for nodeType 'org')
 * @param {string} [p.actorId] - user id for the audit event
 * @param {string} [p.label] - agentic_team: human label used to build the
 *   room name as `${orgName} > ${label}` (callers that know the team's real
 *   name, e.g. the internal provision endpoint). Falls back to
 *   `Agentic Team <nodeId>` when omitted. dev_slot: the caller-supplied room
 *   name verbatim (collector passes `Slots > <slot name>`); falls back to
 *   `Slots > <short nodeId>` when omitted.
 * @param {{ orchestratorAgentId: string, memberAgentIds: string[] }} [p.roster]
 *   - agentic_team only: explicit roster override, used instead of
 *   resolveTeamRoster(orgId, nodeId). Callers that already know the team's
 *   manifest (e.g. the tasks service, relayed through the internal endpoint)
 *   pass this so auth never has to re-derive it from the agents table.
 * @returns {Promise<{ status: string, row?: object, reason?: string }>}
 */
export async function provisionRoomForNode({ orgId, nodeType, nodeId, actorId, label, roster }) {
    if (!PROVISIONABLE_NODE_TYPES.includes(nodeType)) {
        return { status: 'skipped', reason: `unsupported node_type ${nodeType}` };
    }

    // agentic_team nodes are AI-only rosters with no scope row (082-matrix-
    // rooms.sql: scope_id is null for agentic_team / curated / commanderq),
    // so the scope-walking logic below does not apply to them.
    // QUOXCHAT-PRO P2: quoxchat nodes (one governed room per handed-off
    // website conversation, node_id = widget_conversations.id) follow the
    // same no-scope pattern: no scope row, membership = org admins (+ actor),
    // and NO resident agent (join_agents stays empty; the AI must not answer
    // in the room while a human owns the chat).
    // DEVSUITE-SLOTS #456 phase 4: dev_slot nodes (node_id = collector
    // dev_slots.id) are the same no-scope shape as agentic_team/quoxchat
    // (org admins + actor), but DO carry a resident agent ('quox') so a slot
    // room answers @mentions even with no session holding the slot.
    const isAgenticTeam = nodeType === 'agentic_team';
    const isQuoxchat = nodeType === 'quoxchat';
    const isDevSlot = nodeType === 'dev_slot';
    const isNoScope = isAgenticTeam || isQuoxchat || isDevSlot;
    const scope = isNoScope ? null : getScopeForEntity(nodeType, nodeId);
    if (!isNoScope && (!scope || scope.org_id !== orgId)) {
        return { status: 'skipped', reason: 'scope not found for node' };
    }

    // Attached auto-teams share their parent node's room (plan decision 7).
    if (nodeType === 'team' && isAutoAttachedTeam(nodeId, orgId)) {
        return { status: 'skipped', reason: 'auto-attached team shares its node room' };
    }

    // agentic_team: an explicit roster override takes priority (the caller
    // already knows the manifest); resolveTeamRoster stays the fallback for
    // callers (e.g. the backfill sweep) that only have the node id.
    let effectiveRoster = null;
    if (isAgenticTeam) {
        if (roster) {
            const allAgentIds = [...new Set([roster.orchestratorAgentId, ...(roster.memberAgentIds || [])])];
            effectiveRoster = {
                orchestratorAgentId: roster.orchestratorAgentId,
                memberAgentIds: allAgentIds.filter((id) => id !== roster.orchestratorAgentId),
                allAgentIds,
            };
        } else {
            effectiveRoster = resolveTeamRoster(orgId, nodeId);
            if (!effectiveRoster) {
                console.warn(`[matrixProvisioner] agentic_team ${nodeId}: roster unresolved, room will have no default agent`);
            }
        }
    }

    const roomAlias = computeRoomAlias(orgId, nodeType, nodeId);
    const defaultAgent = isQuoxchat
        ? null // no default agent: puppet-relayed visitor chat, humans reply
        : (isDevSlot
            ? COMMANDERQ_AGENT_ID // 'quox': slot rooms always have a resident agent
            : (isAgenticTeam
                ? (effectiveRoster ? effectiveRoster.orchestratorAgentId : null)
                : resolveDefaultAgent(scope.id)));
    const { row, created } = ensureLedgerRow({
        orgId, nodeType, nodeId, scopeId: scope ? scope.id : null, roomAlias, defaultAgent,
    });

    if (created) {
        createAuditEvent({
            orgId,
            actorType: actorId ? 'user' : 'system',
            actorId: actorId || 'quox-provisioner',
            action: 'matrix.room.provision',
            targetType: 'matrix_room',
            targetId: row.id,
            scopeId: scope ? scope.id : null,
            metadata: { node_type: nodeType, node_id: nodeId, room_alias: roomAlias },
        });
    }

    // M-ROOMS roster re-diff: an active agentic_team room re-provisioned with
    // an explicit roster still calls the appservice (adopt path: joins any
    // missing member puppets, restamps state, re-invites humans) so a team
    // PATCH that changes members reaches the live room. Additive only:
    // membership removal stays a deprovision concern, and user-invited extra
    // agents are never kicked.
    const reconcile = row.status === 'active' && isAgenticTeam && !!roster && !!row.room_id;
    if (row.status === 'active' && !reconcile) {
        return { status: 'exists', row };
    }

    // agentic_team / quoxchat rooms have no scoped human seat: the humans
    // present are org admins (oversight tier for teams; the operator pool for
    // quoxchat handoffs) plus whoever actually created/requested it.
    const membership = isNoScope
        ? { humans: [...new Set([...orgAdminIds(orgId), ...(actorId ? [actorId] : [])])] }
        : computeMembership(scope);
    const state = buildRoomState({
        orgId, nodeType, nodeId, scopeId: scope ? scope.id : null, defaultAgent,
    });

    const roomLabel = isQuoxchat
        // Caller passes "QuoxChat · <visitor label>"; the label-less
        // fallback mirrors the collector's word-safe short form
        // (quoxchatMatrixRelay.shortVisitorLabel) instead of dumping the
        // full conversation ULID into the room name.
        ? (label || `QuoxChat · Visitor ${shortNodeLabel(nodeId)}`)
        : (isDevSlot
            // Caller (collector) passes "Slots > <slot name>" verbatim; the
            // label-less fallback uses the same word-safe short form so a
            // slot id never dumps raw into the room name.
            ? (label || `Slots > ${shortNodeLabel(nodeId)}`)
            : (isAgenticTeam
                ? (label ? `${resolveOrgName(orgId)} > ${label}` : `Agentic Team ${nodeId}`)
                : buildBreadcrumbLabel(scope)));
    // Full roster for agentic_team (deduplicated above); every other node
    // type keeps today's single-default-agent invite.
    const joinAgents = isAgenticTeam && effectiveRoster ? effectiveRoster.allAgentIds : (defaultAgent ? [defaultAgent] : []);

    const result = await callAppserviceProvision({
        org_id: orgId,
        room_alias: roomAlias,
        name: roomLabel,
        topic: `Quox ${nodeType} room: ${roomLabel}`,
        state,
        invite_users: membership.humans,
        join_agents: joinAgents,
    });

    if (result && result.room_id) {
        prepare(`
            UPDATE matrix_rooms
            SET room_id = ?, status = 'active', last_synced_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(result.room_id, row.id);
        return { status: reconcile ? 'reconciled' : 'provisioned', row: prepare('SELECT * FROM matrix_rooms WHERE id = ?').get(row.id) };
    }

    // A failed reconcile leaves the row exactly as it was: still active, the
    // room still works with its previous roster; the next lifecycle call retries.
    if (reconcile) {
        return { status: 'exists', row };
    }

    // Appservice side not live yet (stub) or call failed: row stays pending;
    // the backfill sweep is the retry path.
    return { status: created ? 'pending' : 'still_pending', row };
}

/**
 * Retire the room for one org-tree node (teardown counterpart to
 * provisionRoomForNode). Idempotent: a node with no ledger row is a no-op,
 * an already-retired row is a no-op. Fail-soft by contract: if the appservice
 * is unreachable the ledger row is left untouched (status unchanged) so a
 * later retry can finish the teardown; the room's own lifecycle (createRoom
 * side, invites) is never a blocker for the node deletion that triggered this.
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {string} p.nodeType
 * @param {string} p.nodeId
 * @param {string} [p.actorId] - user id for the audit event
 * @returns {Promise<{ status: string, row?: object, reason?: string }>}
 */
export async function deprovisionRoomForNode({ orgId, nodeType, nodeId, actorId }) {
    const row = prepare(
        'SELECT * FROM matrix_rooms WHERE org_id = ? AND node_type = ? AND node_id = ?'
    ).get(orgId, nodeType, nodeId);
    if (!row) return { status: 'skipped', reason: 'no ledger row' };
    if (row.status === 'retired') return { status: 'exists', row };

    // A pending row (never went active) has no room_id, so there is nothing
    // for the appservice to tear down; a room_id row needs the live call.
    let appserviceOk = true;
    if (row.room_id) {
        const result = await callAppserviceDeprovision(row.room_id);
        appserviceOk = result === true;
    }

    if (!appserviceOk) {
        return { status: 'retire_pending', row };
    }

    prepare(`
        UPDATE matrix_rooms
        SET status = 'retired', updated_at = datetime('now')
        WHERE id = ?
    `).run(row.id);

    createAuditEvent({
        orgId,
        actorType: actorId ? 'user' : 'system',
        actorId: actorId || 'quox-provisioner',
        action: 'matrix.room.deprovision',
        targetType: 'matrix_room',
        targetId: row.id,
        scopeId: row.scope_id || null,
        metadata: { node_type: nodeType, node_id: nodeId, room_alias: row.room_alias },
    });

    return { status: 'retired', row: prepare('SELECT * FROM matrix_rooms WHERE id = ?').get(row.id) };
}

function isAutoAttachedTeam(teamId, orgId) {
    const team = prepare(
        'SELECT settings_json, attach_scope_id FROM teams WHERE id = ? AND org_id = ?'
    ).get(teamId, orgId);
    if (!team || !team.attach_scope_id) return false;
    const attachScope = getScopeById(team.attach_scope_id);
    // A team attached to a NON-team scope (org/division/department) whose
    // settings mark it auto-created is that node's seat, not a standalone team.
    if (!attachScope || attachScope.scope_type === 'team') return false;
    try {
        const settings = JSON.parse(team.settings_json || '{}');
        return settings.auto_created === true;
    } catch {
        return false;
    }
}

/**
 * Provision the per-tenant CommanderQ room: org admins only, `quox` as the
 * resident agent, no scope row (it sits above the org tree). Idempotent via
 * the same ledger constraint.
 *
 * @returns {Promise<{ status: string, row?: object }>}
 */
export async function provisionCommanderQRoom(orgId, actorId) {
    const roomAlias = computeRoomAlias(orgId, COMMANDERQ_NODE_ID, COMMANDERQ_NODE_ID);
    const { row, created } = ensureLedgerRow({
        orgId,
        nodeType: COMMANDERQ_NODE_ID,
        nodeId: COMMANDERQ_NODE_ID,
        scopeId: null,
        roomAlias,
        defaultAgent: COMMANDERQ_AGENT_ID,
    });

    if (created) {
        createAuditEvent({
            orgId,
            actorType: actorId ? 'user' : 'system',
            actorId: actorId || 'quox-provisioner',
            action: 'matrix.room.provision',
            targetType: 'matrix_room',
            targetId: row.id,
            metadata: { node_type: COMMANDERQ_NODE_ID, room_alias: roomAlias },
        });
    }
    if (row.status === 'active') return { status: 'exists', row };

    const roomLabel = `${resolveOrgName(orgId)} > CommanderQ`;
    const result = await callAppserviceProvision({
        org_id: orgId,
        room_alias: roomAlias,
        name: roomLabel,
        topic: `CommanderQuox, org admins only: ${roomLabel}`,
        state: {
            'ai.quox.room': {
                v: 2,
                org_id: orgId,
                node_type: COMMANDERQ_NODE_ID,
                node_id: COMMANDERQ_NODE_ID,
                scope_id: null,
                default_agent: COMMANDERQ_AGENT_ID,
                provisioned_by: 'quox-provisioner',
                provisioned_at: nowIso(),
            },
            'ai.quox.org': { org_id: orgId },
        },
        invite_users: orgAdminIds(orgId),
        join_agents: [COMMANDERQ_AGENT_ID],
    });

    if (result && result.room_id) {
        prepare(`
            UPDATE matrix_rooms
            SET room_id = ?, status = 'active', last_synced_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
        `).run(result.room_id, row.id);
        return { status: 'provisioned', row: prepare('SELECT * FROM matrix_rooms WHERE id = ?').get(row.id) };
    }
    return { status: created ? 'pending' : 'still_pending', row };
}

/**
 * Idempotent backfill/reconcile sweep, same contract as backfillTeams /
 * backfill-scope-assistants: brings every existing node up to parity and
 * retries pending/failed eager attempts. Safe to run repeatedly; a second
 * run creates nothing new.
 *
 * KNOWN GAP (DEVSUITE-SLOTS #456 phase 4): this sweep enumerates scopes
 * (org/division/department/team) plus one CommanderQ room per org, both
 * sourced from auth's own database. dev_slot nodes live in the collector's
 * dev_slots table, a separate process/DB auth cannot reach here, so this
 * sweep deliberately does NOT enumerate or retry them — hacking a cross-DB
 * read in would break the service boundary. The healing path for a slot
 * whose provision attempt was lost (e.g. a crash between create and the
 * fire-and-forget landing) is collector-side instead: a later checkout
 * re-attempts provisionSlotRoom() when dev_slots.matrix_room_id is still
 * null (services/collector/server.js, POST /api/v1/slots/:name/checkout).
 *
 * @param {object} [opts]
 * @param {string} [opts.orgId] - restrict to one org (default: all orgs)
 * @returns {Promise<{ created: number, pending: number, skipped: number, errors: string[] }>}
 */
export async function backfillRooms({ orgId } = {}) {
    getDb();
    const errors = [];
    let created = 0;
    let pending = 0;
    let skipped = 0;

    const orgFilter = orgId ? 'AND s.org_id = ?' : '';
    const params = orgId ? [orgId] : [];
    const scopes = prepare(`
        SELECT s.* FROM scopes s
        WHERE s.scope_type IN ('org', 'division', 'department', 'team') ${orgFilter}
        ORDER BY s.depth ASC, s.created_at ASC
    `).all(...params);

    for (const scope of scopes) {
        try {
            const result = await provisionRoomForNode({
                orgId: scope.org_id,
                nodeType: scope.scope_type,
                nodeId: scope.ref_id,
            });
            if (result.status === 'provisioned') created++;
            else if (result.status === 'pending') { created++; pending++; }
            else if (result.status === 'still_pending') pending++;
            else skipped++;
        } catch (err) {
            errors.push(`Scope ${scope.id} (${scope.name_cache || 'unnamed'}): ${err.message}`);
        }
    }

    // One CommanderQ room per tenant.
    const orgs = orgId
        ? [{ id: orgId }]
        : prepare('SELECT id FROM orgs WHERE deleted_at IS NULL').all();
    for (const org of orgs) {
        try {
            const result = await provisionCommanderQRoom(org.id);
            if (result.status === 'provisioned') created++;
            else if (result.status === 'pending') { created++; pending++; }
            else if (result.status === 'still_pending') pending++;
            else skipped++;
        } catch (err) {
            errors.push(`CommanderQ for org ${org.id}: ${err.message}`);
        }
    }

    return { created, pending, skipped, errors };
}

export default {
    PROVISIONABLE_NODE_TYPES,
    perOrgIdentityEnabled,
    isMatrixRoomsEnabled,
    computeRoomAlias,
    resolveDefaultAgent,
    resolveTeamRoster,
    buildRoomState,
    computeMembership,
    ensureLedgerRow,
    humanMatrixUserId,
    agentLocalpart,
    callAppserviceProvision,
    callAppserviceDeprovision,
    callAppserviceMigrateHumans,
    migrateRoomsToOrgIdentities,
    provisionRoomForNode,
    deprovisionRoomForNode,
    provisionCommanderQRoom,
    backfillRooms,
};
