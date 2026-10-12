/**
 * ET-4 Phase D — customRoles frontend client.
 *
 * Pure helpers + thin fetch wrappers over authFetch. No React here.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidRoleSlug(slug) {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Group a list of capability rows ({capability, scope_id?}) by the
 * dotted prefix of the capability (e.g. "org", "team", "agent").
 * Caps without a dot land in an "other" bucket.
 */
export function groupCapabilitiesByResource(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return {};
    const out = {};
    for (const row of rows) {
        const cap = row?.capability;
        if (typeof cap !== 'string') continue;
        const key = cap.includes('.') ? cap.split('.')[0] : 'other';
        if (!out[key]) out[key] = [];
        out[key].push(row);
    }
    return out;
}

async function parseOrEmpty(response) {
    try { return await response.json(); } catch { return null; }
}

// ET-ENFORCE — wrap thrown errors with structured fields so callers can
// render code-specific copy via AuthContext.describeServerError instead of
// dumping the raw HTTP status in a toast.
function enforceError(res, body, fallback) {
    const err = new Error(body?.message || fallback);
    err.status = res.status;
    err.code   = body?.error || null;
    err.required = body?.required || null;
    return err;
}

/**
 * Assign a custom role overlay to a membership (or clear with custom_role_id=null).
 * The backend refuses self-target, peer-tier modification, escalation
 * beyond the assigner's caps, and cross-org role IDs — see ET-ENFORCE
 * round-3/4 audit fixes. The thrown error carries .code so callers can
 * surface "forbidden_escalation" / "cannot_modify_higher_role" /
 * "cannot_modify_own_membership" with specific copy.
 */
export async function assignMembershipCustomRole(orgId, userId, customRoleId, authFetch) {
    if (!orgId || !userId) throw new Error('orgId and userId required');
    const res = await authFetch(
        `/api/orgs/${orgId}/members/${encodeURIComponent(userId)}/custom-role`,
        {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ custom_role_id: customRoleId ?? null }),
        },
    );
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `assignMembershipCustomRole: ${res.status}`);
    }
    return parseOrEmpty(res);
}

export async function fetchCustomRoles(orgId, authFetch) {
    if (!orgId) throw new Error('orgId required');
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchCustomRoles: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.roles || [];
}

export async function fetchCustomRole(orgId, roleId, authFetch) {
    if (!orgId || !roleId) throw new Error('orgId and roleId required');
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fetchCustomRole: ${res.status}`);
    return parseOrEmpty(res);
}

export async function createCustomRole(orgId, { slug, name, description = null }, authFetch) {
    if (!isValidRoleSlug(slug)) {
        throw new Error(`invalid slug "${slug}" — lowercase a–z, 0–9, _ or -`);
    }
    if (!name || typeof name !== 'string') throw new Error('name required');
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug, name, description }),
    });
    if (res.status === 409) {
        throw enforceError(res, await parseOrEmpty(res), 'slug_in_use');
    }
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `createCustomRole: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.role;
}

export async function deleteCustomRole(orgId, roleId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw enforceError(res, await parseOrEmpty(res), `deleteCustomRole: ${res.status}`);
}

export async function grantRoleCapability(orgId, roleId, { capability, scopeId = null }, authFetch) {
    if (!capability) throw new Error('capability required');
    const res = await authFetch(`/api/orgs/${orgId}/custom-roles/${roleId}/capabilities`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ capability, scope_id: scopeId }),
    });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `grantRoleCapability: ${res.status}`);
    }
    return true;
}

export async function revokeRoleCapability(orgId, roleId, { capability, scopeId = null }, authFetch) {
    if (!capability) throw new Error('capability required');
    const params = new URLSearchParams({ capability });
    if (scopeId) params.set('scope_id', scopeId);
    const res = await authFetch(
        `/api/orgs/${orgId}/custom-roles/${roleId}/capabilities?${params.toString()}`,
        { method: 'DELETE' },
    );
    if (res.status === 204 || res.ok) return true;
    throw enforceError(res, await parseOrEmpty(res), `revokeRoleCapability: ${res.status}`);
}
