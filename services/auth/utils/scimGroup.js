/**
 * ET-3 Phase C2 — SCIM Group mapping.
 *
 * Groups = internal teams. SCIM group.id = team.id.
 * Group.members = team_memberships where status='active'.
 * Member.value = user_id, Member.display = primary_email.
 */

export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

// Internal team + members[] → SCIM Group.
export function toScimGroup(team, members = [], { baseUrl = '' } = {}) {
    return {
        schemas:     [SCIM_GROUP_SCHEMA],
        id:          team.id,
        displayName: team.name,
        members: members.map(m => ({
            value:   m.user_id,
            display: m.primary_email || undefined,
            type:    'User',
            $ref:    baseUrl ? `${baseUrl.replace(/\/$/, '')}/scim/v2/Users/${m.user_id}` : undefined,
        })),
        meta: {
            resourceType: 'Group',
            created:      team.created_at || undefined,
            lastModified: team.updated_at || undefined,
            location:     baseUrl ? `${baseUrl.replace(/\/$/, '')}/scim/v2/Groups/${team.id}` : undefined,
        },
    };
}

// Parse POST / PUT body.
export function parseScimGroupPayload(body = {}) {
    if (!body.displayName || typeof body.displayName !== 'string') {
        throw new Error('displayName is required');
    }
    const members = Array.isArray(body.members) ? body.members : [];
    const memberIds = [
        ...new Set(members.map(m => m && typeof m.value === 'string' ? m.value : null).filter(Boolean)),
    ];
    return { displayName: body.displayName, memberIds };
}

// Parse a members[value eq "X"] path — used by PATCH remove.
function memberIdFromFilterPath(path) {
    const m = path.match(/^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i);
    return m ? m[1] : null;
}

export function applyScimGroupPatch(current, body) {
    const next = {
        displayName: current.displayName,
        memberIds:   [...current.memberIds],
    };
    const ops = Array.isArray(body?.Operations) ? body.Operations : [];
    for (const o of ops) {
        if (!o || typeof o !== 'object') continue;
        const op   = String(o.op || '').toLowerCase();
        const path = typeof o.path === 'string' ? o.path : '';

        if (path === 'displayName' && (op === 'replace' || op === 'add')) {
            if (typeof o.value === 'string') next.displayName = o.value;
            continue;
        }
        if (path === 'members' && (op === 'add' || op === 'replace')) {
            const arr = Array.isArray(o.value) ? o.value : [];
            const ids = arr.map(x => x?.value).filter(v => typeof v === 'string');
            next.memberIds = op === 'replace'
                ? [...new Set(ids)]
                : [...new Set([...next.memberIds, ...ids])];
            continue;
        }
        if (op === 'remove' && path === 'members') {
            // Remove all members when no filter provided.
            next.memberIds = [];
            continue;
        }
        if (op === 'remove') {
            const id = memberIdFromFilterPath(path);
            if (id) {
                next.memberIds = next.memberIds.filter(x => x !== id);
                continue;
            }
        }
        // Unknown path → no-op (forward-compat).
    }
    return next;
}
