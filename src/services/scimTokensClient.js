/**
 * ET-3 Phase E — SCIM tokens frontend client.
 */

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

export async function fetchScimTokens(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/scim/tokens`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchScimTokens: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.tokens || [];
}

export async function createScimToken(orgId, { label = null } = {}, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/scim/tokens`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ label }),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `createScimToken: ${res.status}`);
    }
    return parseOrEmpty(res);
}

export async function revokeScimToken(orgId, tokenId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/scim/tokens/${tokenId}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw new Error(`revokeScimToken: ${res.status}`);
}
