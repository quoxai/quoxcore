/**
 * ET-4 Phase D — org security frontend client.
 *
 * Session policy + IP allowlist + MFA policy. Pure validators +
 * fetch wrappers. No React; authFetch is passed in.
 */

export const MFA_MODES = Object.freeze({
    DISABLED: 'disabled',
    OPTIONAL: 'optional',
    REQUIRED: 'required',
});

const MFA_VALUES = new Set(Object.values(MFA_MODES));

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────

export function isValidCidr(input) {
    if (typeof input !== 'string' || !input.length) return false;
    const [ipPart, prefixPart] = input.split('/');
    const octets = ipPart.split('.');
    if (octets.length !== 4) return false;
    for (const o of octets) {
        if (!/^\d{1,3}$/.test(o)) return false;
        const n = Number(o);
        if (n < 0 || n > 255) return false;
    }
    if (prefixPart === undefined) return true;
    if (!/^\d{1,2}$/.test(prefixPart)) return false;
    const p = Number(prefixPart);
    return p >= 0 && p <= 32;
}

export function formatIdleMinutes(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return 0;
    return Math.floor(seconds / 60);
}

async function parseOrEmpty(response) {
    try { return await response.json(); } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────
// Session policy
// ──────────────────────────────────────────────────────────────────────

export async function fetchSessionPolicy(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/security/session-policy`);
    if (res.status === 402 || res.status === 404) return null;
    if (!res.ok) throw new Error(`fetchSessionPolicy: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.policy || null;
}

export async function setSessionPolicy(orgId, patch, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/security/session-policy`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `setSessionPolicy: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.policy || null;
}

// ──────────────────────────────────────────────────────────────────────
// IP allowlist
// ──────────────────────────────────────────────────────────────────────

export async function fetchIpAllowlist(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/security/ip-allowlist`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchIpAllowlist: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.entries || [];
}

export async function addIpAllowlistEntry(orgId, { cidr, label = null }, authFetch) {
    if (!isValidCidr(cidr)) throw new Error(`invalid cidr "${cidr}"`);
    const res = await authFetch(`/api/orgs/${orgId}/security/ip-allowlist`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cidr, label }),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `addIpAllowlistEntry: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.entry;
}

export async function removeIpAllowlistEntry(orgId, entryId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/security/ip-allowlist/${entryId}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw new Error(`removeIpAllowlistEntry: ${res.status}`);
}

// ──────────────────────────────────────────────────────────────────────
// MFA policy
// ──────────────────────────────────────────────────────────────────────

export async function fetchMfaPolicy(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/security/mfa`);
    if (res.status === 402 || res.status === 404) return null;
    if (!res.ok) throw new Error(`fetchMfaPolicy: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.mode || null;
}

export async function setMfaPolicy(orgId, mode, authFetch) {
    if (!MFA_VALUES.has(mode)) {
        throw new Error(`invalid mode "${mode}" — expected one of ${[...MFA_VALUES].join(', ')}`);
    }
    const res = await authFetch(`/api/orgs/${orgId}/security/mfa`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode }),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `setMfaPolicy: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.mode;
}
