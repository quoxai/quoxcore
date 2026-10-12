/**
 * ET-3 Phase C1 — SCIM User mapping.
 *
 * Maps between the internal user + org_membership shape and the
 * SCIM 2.0 User resource (RFC 7643 §4.1). Also parses incoming
 * Create / Replace / Patch payloads into a normalised intent shape
 * that the route layer applies to the DB.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

// ──────────────────────────────────────────────────────────────────────
// Internal → SCIM
// ──────────────────────────────────────────────────────────────────────

export function toScimUser(user, { orgId = null, baseUrl = '' } = {}) {
    const active = user.status === 'active' || user.status == null;
    return {
        schemas:    [SCIM_USER_SCHEMA],
        id:         user.id,
        externalId: user.external_id || undefined,
        userName:   user.primary_email,
        active,
        name: {
            formatted: user.display_name || null,
        },
        emails: [
            { value: user.primary_email, primary: true, type: 'work' },
        ],
        meta: {
            resourceType: 'User',
            created:      user.created_at || undefined,
            lastModified: user.updated_at || undefined,
            location:     baseUrl ? `${baseUrl.replace(/\/$/, '')}/scim/v2/Users/${user.id}` : undefined,
            ...(orgId ? { orgId } : {}),
        },
    };
}

// ──────────────────────────────────────────────────────────────────────
// SCIM → internal
// ──────────────────────────────────────────────────────────────────────

function firstPrimaryEmail(emails) {
    if (!Array.isArray(emails)) return null;
    const primary = emails.find(e => e && e.primary);
    if (primary?.value) return String(primary.value).toLowerCase();
    const first = emails.find(e => e?.value);
    return first ? String(first.value).toLowerCase() : null;
}

function deriveDisplayName(body) {
    if (typeof body.displayName === 'string' && body.displayName) return body.displayName;
    const n = body.name;
    if (n && typeof n === 'object') {
        if (n.formatted) return String(n.formatted);
        const joined = [n.givenName, n.familyName].filter(Boolean).join(' ');
        if (joined) return joined;
    }
    return null;
}

export function parseScimUserPayload(body = {}) {
    const email =
        (typeof body.userName === 'string' && body.userName)
            ? body.userName.toLowerCase()
            : firstPrimaryEmail(body.emails);
    if (!email) throw new Error('SCIM payload requires userName or emails[].value');
    return {
        email,
        displayName: deriveDisplayName(body),
        externalId:  typeof body.externalId === 'string' ? body.externalId : null,
        active:      body.active === false ? false : (body.active === true ? true : true),
    };
}

// ──────────────────────────────────────────────────────────────────────
// PATCH (RFC 7644 §3.5.2) — subset sufficient for common IdP ops
// ──────────────────────────────────────────────────────────────────────

const PATH_HANDLERS = {
    active:           (state, value, op)       => { state.active = op === 'remove' ? false : value !== false; },
    userName:         (state, value)           => { if (typeof value === 'string') state.email = value.toLowerCase(); },
    displayName:      (state, value)           => { if (typeof value === 'string') state.displayName = value; },
    'name.formatted': (state, value)           => { if (typeof value === 'string') state.displayName = value; },
    externalId:       (state, value)           => { if (typeof value === 'string' || value === null) state.externalId = value; },
};

export function applyScimPatch(current, body) {
    const next = { ...current };
    const ops = Array.isArray(body?.Operations) ? body.Operations : [];
    for (const o of ops) {
        if (!o || typeof o !== 'object') continue;
        const op   = String(o.op || '').toLowerCase();
        const path = o.path;
        // Only replace / remove / add (add behaves like replace for our scalar fields).
        if (!['replace', 'add', 'remove'].includes(op)) continue;
        if (typeof path !== 'string' || !path) continue;
        const handler = PATH_HANDLERS[path];
        if (!handler) continue;                     // forward-compatible no-op
        handler(next, o.value, op);
    }
    return next;
}
