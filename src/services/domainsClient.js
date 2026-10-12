/**
 * ET-3 Phase E — domains frontend client.
 */

export function isValidDomainInput(input) {
    if (typeof input !== 'string' || !input) return false;
    const trimmed = input.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed);
}

export function buildTxtInstructions({ domain, verification_token }) {
    return [
        `Add this TXT record to ${domain}:`,
        '',
        `  Name:  ${domain}`,
        `  Type:  TXT`,
        `  Value: ${verification_token}`,
        '',
        'DNS changes can take up to 48 hours.',
    ].join('\n');
}

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

export async function fetchDomains(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/domains`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchDomains: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.domains || [];
}

export async function startDomain(orgId, domain, authFetch) {
    if (!isValidDomainInput(domain)) throw new Error(`"${domain}" is not a valid domain`);
    const res = await authFetch(`/api/orgs/${orgId}/domains`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain }),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `startDomain: ${res.status}`);
    }
    return parseOrEmpty(res);
}

export async function verifyDomain(orgId, domainId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/domains/${domainId}/verify`, { method: 'POST' });
    const body = await parseOrEmpty(res);
    if (res.status === 202) return body || { verified: false, retryable: true };
    if (res.ok) return body || { verified: true };
    throw new Error(body?.message || `verifyDomain: ${res.status}`);
}

export async function removeDomain(orgId, domainId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/domains/${domainId}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw new Error(`removeDomain: ${res.status}`);
}
