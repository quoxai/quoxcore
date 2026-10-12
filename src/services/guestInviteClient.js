/**
 * ET-6D — guest invite frontend client.
 */

// Frontend-visible types. 'regular' is intentionally absent — use the
// existing invite flow for those.
export const GUEST_INVITE_TYPES = ['guest', 'assistant_scoped'];
const TYPE_SET = new Set(GUEST_INVITE_TYPES);

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isValidEmail(input) {
    return typeof input === 'string' && EMAIL_RE.test(input);
}

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

// ET-ENFORCE — wrap thrown errors with structured fields so callers can
// route by .code (e.g. 'invite_not_usable') instead of HTTP status alone.
function enforceError(res, body, fallback) {
    const err = new Error(body?.message || fallback);
    err.status = res.status;
    err.code   = body?.error || null;
    err.required = body?.required || null;
    return err;
}

export async function createGuestInvite(orgId, { email, targetScopeId, inviteType = 'guest' }, authFetch) {
    if (!isValidEmail(email))     throw new Error(`invalid email "${email}"`);
    if (!targetScopeId)           throw new Error('target_scope_id is required');
    if (!TYPE_SET.has(inviteType)) {
        throw new Error(`invalid invite_type "${inviteType}" — expected ${GUEST_INVITE_TYPES.join(' or ')}`);
    }
    const res = await authFetch(`/api/orgs/${orgId}/invites/guest`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, target_scope_id: targetScopeId, invite_type: inviteType }),
    });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `createGuestInvite: ${res.status}`);
    }
    const out = await parseOrEmpty(res);
    return out?.invite;
}

export async function acceptGuestInvite(token, authFetch) {
    if (!token) throw new Error('token required');
    const res = await authFetch(`/api/invites/${encodeURIComponent(token)}/accept-guest`, {
        method: 'POST',
    });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `acceptGuestInvite: ${res.status}`);
    }
    return parseOrEmpty(res);
}

/**
 * ET-ENFORCE Phase G — anonymous guest signup-and-accept. No auth header
 * required. The token (URL-safe, ≥24 random bytes) is the only credential.
 * On success the response sets httpOnly access + refresh cookies and
 * returns the user payload. Errors carry .code so the landing page can
 * distinguish 'invite_not_usable' (token gone) from 'email_exists' (sign
 * in first) from 'weak_password' from 'ip_not_allowed'.
 */
export async function signupAndAcceptGuestInvite(token, { password, displayName }) {
    if (!token) throw new Error('token required');
    if (!password) throw new Error('password required');
    const res = await fetch(`/api/invites/${encodeURIComponent(token)}/signup-and-accept`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:    JSON.stringify({
            password,
            ...(displayName ? { display_name: displayName } : {}),
        }),
    });
    if (!res.ok) {
        throw enforceError(res, await parseOrEmpty(res), `signupAndAcceptGuestInvite: ${res.status}`);
    }
    return parseOrEmpty(res);
}
