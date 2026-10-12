/**
 * ET-6D — agent + tool RBAC frontend client.
 *
 * Wraps the Enterprise admin endpoints added in ET-6A.
 */

// UI sentinel for "no scope / org-wide" — translated to NULL on the wire.
export const SCOPE_ORG_WIDE = '__org__';

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

function normaliseScope(scopeId) {
    if (!scopeId || scopeId === SCOPE_ORG_WIDE) return null;
    return String(scopeId);
}

// ──────────────────────────────────────────────────────────────────────
// Agent permissions
// ──────────────────────────────────────────────────────────────────────

export async function fetchAgentPermissions(orgId, roleId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}/agents`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchAgentPermissions: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.permissions || [];
}

export async function setAgentPermission(orgId, roleId, { agentId, allowed, scopeId }, authFetch) {
    if (!agentId)                    throw new Error('agent_id required');
    if (typeof allowed !== 'boolean') throw new Error('allowed must be boolean');
    const body = { agent_id: agentId, allowed, scope_id: normaliseScope(scopeId) };
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}/agents`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    if (!res.ok) {
        const b = await parseOrEmpty(res);
        throw new Error(b?.message || `setAgentPermission: ${res.status}`);
    }
    return true;
}

export async function clearAgentPermission(orgId, roleId, { agentId, scopeId }, authFetch) {
    if (!agentId) throw new Error('agent_id required');
    const params = new URLSearchParams({ agent_id: agentId });
    const s = normaliseScope(scopeId);
    if (s) params.set('scope_id', s);
    const res = await authFetch(
        `/api/orgs/${orgId}/custom-roles/${roleId}/agents?${params.toString()}`,
        { method: 'DELETE' },
    );
    if (res.status === 204 || res.ok) return true;
    throw new Error(`clearAgentPermission: ${res.status}`);
}

// ──────────────────────────────────────────────────────────────────────
// Tool permissions
// ──────────────────────────────────────────────────────────────────────

export async function fetchToolPermissions(orgId, roleId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}/tools`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchToolPermissions: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.permissions || [];
}

export async function setToolPermission(orgId, roleId, { toolId, allowed }, authFetch) {
    if (!toolId)                      throw new Error('tool_id required');
    if (typeof allowed !== 'boolean') throw new Error('allowed must be boolean');
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}/tools`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tool_id: toolId, allowed }),
    });
    if (!res.ok) {
        const b = await parseOrEmpty(res);
        throw new Error(b?.message || `setToolPermission: ${res.status}`);
    }
    return true;
}

export async function clearToolPermission(orgId, roleId, toolId, authFetch) {
    if (!toolId) throw new Error('tool_id required');
    const res = await authFetch(
        `/api/orgs/${orgId}/custom-roles/${roleId}/tools?tool_id=${encodeURIComponent(toolId)}`,
        { method: 'DELETE' },
    );
    if (res.status === 204 || res.ok) return true;
    throw new Error(`clearToolPermission: ${res.status}`);
}
