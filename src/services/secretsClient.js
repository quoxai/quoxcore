/**
 * ET-6D — secrets frontend client.
 *
 * Team tier+. Values are never kept in the client after reveal —
 * the caller is expected to render-and-clear.
 */

// Sentinel used on the list endpoint to target org-wide (scope_id IS NULL)
// secrets. Matches the backend's ?scope_id=org filter.
export const SCOPE_ORG = 'org';

const NAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

export function isValidSecretName(input) {
    return typeof input === 'string' && NAME_RE.test(input);
}

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

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

// ──────────────────────────────────────────────────────────────────────

export async function fetchSecrets(orgId, { scopeId } = {}, authFetch) {
    let url = `/api/orgs/${orgId}/secrets`;
    if (scopeId !== undefined && scopeId !== null) {
        url += `?scope_id=${encodeURIComponent(scopeId)}`;
    }
    const res = await authFetch(url);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchSecrets: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.secrets || [];
}

export async function createSecret(orgId, { name, value, description = null, scopeId = null, metadata = {} }, authFetch) {
    if (!isValidSecretName(name)) throw new Error(`invalid name "${name}" — A–Z, a–z, 0–9, _ . -`);
    if (typeof value !== 'string' || !value) throw new Error('value is required');

    const body = { name, value };
    if (description) body.description = description;
    // SCOPE_ORG and null both mean org-wide; omit the field so the
    // backend stores scope_id = NULL.
    if (scopeId && scopeId !== SCOPE_ORG) body.scope_id = scopeId;
    if (Object.keys(metadata).length) body.metadata = metadata;

    const res = await authFetch(`/api/orgs/${orgId}/secrets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    if (res.status === 409) {
        throw enforceError(res, await parseOrEmpty(res), 'secret already exists');
    }
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `createSecret: ${res.status}`);
    }
    const out = await parseOrEmpty(res);
    return out?.secret;
}

export async function revealSecret(orgId, id, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/secrets/${id}/reveal`, { method: 'POST' });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `revealSecret: ${res.status}`);
    }
    return parseOrEmpty(res);
}

export async function updateSecret(orgId, id, patch, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/secrets/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
    });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `updateSecret: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.secret;
}

export async function rotateSecret(orgId, id, value, authFetch) {
    if (typeof value !== 'string' || !value) throw new Error('rotated value required');
    return updateSecret(orgId, id, { value }, authFetch);
}

export async function deleteSecret(orgId, id, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/secrets/${id}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw enforceError(res, await parseOrEmpty(res), `deleteSecret: ${res.status}`);
}
