/**
 * ET-3 Phase C1 — SCIM 2.0 endpoints.
 *
 * Authenticates via a per-org bearer scim_token (no cookies). Every
 * request is scoped to exactly one org. Users map to internal users
 * + an active org_membership in that org.
 *
 * This is an MVP — Users only. Groups and richer filter expressions
 * land in Phase C2.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import { verifyScimBearer } from '../utils/scimTokens.js';
import { toScimUser, parseScimUserPayload, applyScimPatch, SCIM_USER_SCHEMA } from '../utils/scimUser.js';
import { toScimGroup, parseScimGroupPayload, applyScimGroupPatch, SCIM_GROUP_SCHEMA } from '../utils/scimGroup.js';
import { parseScimFilter } from '../utils/scimFilter.js';
import { emitAndDispatch } from '../utils/teamEventEmitter.js';

const router = Router();

function db(req) { return req.db || getDb(); }

function baseUrl(req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
}

function scimError(res, status, message, scimType) {
    return res
        .type('application/scim+json')
        .status(status)
        .json({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status:  String(status),
            detail:  message,
            ...(scimType ? { scimType } : {}),
        });
}

// ──────────────────────────────────────────────────────────────────────
// Auth middleware
// ──────────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
    const token = verifyScimBearer(db(req), req.headers.authorization || '');
    if (!token) return scimError(res, 401, 'missing or invalid scim bearer token');
    req.scimOrgId = token.org_id;
    next();
});

// ET-ENFORCE round-3 + round-4 — SCIM owner-protection. A leaked SCIM token
// must not be able to deprovision the org's owner (locking the org out)
// or suspend the last active owner — and must not rewrite the owner's
// identity (email, display name, external_id) which would enable
// password-reset hijack. Returns null if safe to mutate, else a SCIM
// error payload.
//
// Owner is identified by EITHER (a) the org_memberships.role='owner' row
// for the SCIM-authenticated org, OR (b) the orgs.owner_user_id creator-
// of-record. Both are checked: if a transfer-ownership flow updated one
// but not the other, the row that disagrees still wins.
function checkOwnerGuard(req, targetUserId) {
    try {
        const m = db(req).prepare(`
            SELECT role FROM org_memberships
            WHERE org_id = ? AND user_id = ?
        `).get(req.scimOrgId, targetUserId);
        if (m && m.role === 'owner') {
            return { reason: 'cannot_modify_owner_via_scim' };
        }
    } catch { /* table missing in legacy harness — fall through */ }
    try {
        const o = db(req).prepare(`
            SELECT owner_user_id FROM orgs WHERE id = ?
        `).get(req.scimOrgId);
        if (o && o.owner_user_id === targetUserId) {
            return { reason: 'cannot_modify_owner_via_scim' };
        }
    } catch { /* legacy schemas may not have owner_user_id — fall through */ }
    return null;
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'scim', 'scim_token', ?, 'user', ?, 'success', ?)
        `).run(ulid(), req.scimOrgId, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[scim] audit insert failed:', err.message);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Service discovery (static metadata)
// ──────────────────────────────────────────────────────────────────────

router.get('/ServiceProviderConfig', (req, res) => {
    res.type('application/scim+json').json({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
        patch:         { supported: true },
        bulk:          { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter:        { supported: true, maxResults: 200 },
        changePassword:{ supported: false },
        sort:          { supported: false },
        etag:          { supported: false },
        authenticationSchemes: [{
            type:        'oauthbearertoken',
            name:        'OAuth Bearer Token',
            description: 'Bearer token issued per-org via the admin API.',
            primary:     true,
        }],
    });
});

router.get('/ResourceTypes', (req, res) => {
    const base = baseUrl(req);
    const types = [
        {
            schemas:    ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id:         'User',
            name:       'User',
            endpoint:   '/Users',
            schema:     SCIM_USER_SCHEMA,
            description:'User Account',
            meta: { resourceType: 'ResourceType', location: `${base}/scim/v2/ResourceTypes/User` },
        },
        {
            schemas:    ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id:         'Group',
            name:       'Group',
            endpoint:   '/Groups',
            schema:     SCIM_GROUP_SCHEMA,
            description:'Group (maps to a team)',
            meta: { resourceType: 'ResourceType', location: `${base}/scim/v2/ResourceTypes/Group` },
        },
    ];
    res.type('application/scim+json').json({
        schemas:     ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: types.length,
        itemsPerPage: types.length,
        startIndex:   1,
        Resources:    types,
    });
});

router.get('/Schemas', (req, res) => {
    const schemas = [
        {
            id:          SCIM_USER_SCHEMA,
            name:        'User',
            description: 'User Account',
            attributes: [
                { name: 'userName',    type: 'string',  multiValued: false, required: true,  mutability: 'readWrite', uniqueness: 'server' },
                { name: 'active',      type: 'boolean', multiValued: false, required: false, mutability: 'readWrite' },
                { name: 'displayName', type: 'string',  multiValued: false, required: false, mutability: 'readWrite' },
                { name: 'externalId',  type: 'string',  multiValued: false, required: false, mutability: 'readWrite' },
                { name: 'emails',      type: 'complex', multiValued: true,  required: false, mutability: 'readWrite' },
            ],
        },
        {
            id:          SCIM_GROUP_SCHEMA,
            name:        'Group',
            description: 'Group (maps to a team)',
            attributes: [
                { name: 'displayName', type: 'string',  multiValued: false, required: true,  mutability: 'readWrite' },
                { name: 'members',     type: 'complex', multiValued: true,  required: false, mutability: 'readWrite' },
            ],
        },
    ];
    res.type('application/scim+json').json({
        schemas:     ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: schemas.length,
        itemsPerPage: schemas.length,
        startIndex:   1,
        Resources:    schemas,
    });
});

// ──────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────

function getOrgMembership(database, orgId, userId) {
    return database.prepare(
        `SELECT id, status, role FROM org_memberships WHERE org_id = ? AND user_id = ?`,
    ).get(orgId, userId);
}

function getUserForOrg(database, orgId, userId) {
    const user = database.prepare(
        `SELECT u.id, u.primary_email, u.display_name, u.external_id,
                u.created_at, u.updated_at,
                m.status AS membership_status
         FROM users u
         INNER JOIN org_memberships m
             ON m.user_id = u.id AND m.org_id = ?
         WHERE u.id = ? AND m.status != 'removed'`,
    ).get(orgId, userId);
    if (!user) return null;
    // SCIM active = membership active in *this* org (not global user status).
    user.status = user.membership_status === 'active' ? 'active' : 'suspended';
    return user;
}

function sendScimUser(req, res, user, status = 200) {
    res.type('application/scim+json')
       .status(status)
       .json(toScimUser(user, { orgId: req.scimOrgId, baseUrl: baseUrl(req) }));
}

// POST /Users — provision
router.post('/Users', (req, res) => {
    let parsed;
    try { parsed = parseScimUserPayload(req.body || {}); }
    catch (err) { return scimError(res, 400, err.message, 'invalidValue'); }

    const database = db(req);
    const existing = database.prepare(
        `SELECT id, display_name, status, external_id FROM users WHERE primary_email = ?`,
    ).get(parsed.email);

    let userId;
    if (existing) {
        userId = existing.id;
        const m = getOrgMembership(database, req.scimOrgId, userId);
        if (m && m.status === 'active') {
            return scimError(res, 409, 'user already exists in this org', 'uniqueness');
        }
    } else {
        userId = ulid();
        database.prepare(`
            INSERT INTO users (id, primary_email, display_name, external_id, status)
            VALUES (?, ?, ?, ?, 'active')
        `).run(userId, parsed.email, parsed.displayName, parsed.externalId);
    }

    database.prepare(`
        INSERT INTO org_memberships (id, org_id, user_id, role, status)
        VALUES (?, ?, ?, 'viewer', ?)
        ON CONFLICT(org_id, user_id) DO UPDATE SET
            status     = excluded.status,
            updated_at = datetime('now')
    `).run(ulid(), req.scimOrgId, userId, parsed.active ? 'active' : 'suspended');

    emitAudit(req, 'scim.user.provisioned', userId, { email: parsed.email });
    const row = getUserForOrg(database, req.scimOrgId, userId);
    return sendScimUser(req, res, row, 201);
});

// GET /Users — list with optional ?filter=
router.get('/Users', (req, res) => {
    let filter = null;
    try { filter = parseScimFilter(req.query.filter, {
        allowedAttrs: ['userName', 'externalId', 'active'],
    }); }
    catch (err) { return scimError(res, 400, err.message, 'invalidFilter'); }

    const startIndex = Math.max(parseInt(req.query.startIndex, 10) || 1, 1);
    const count      = Math.min(Math.max(parseInt(req.query.count, 10) || 100, 0), 200);

    const whereParts = [`m.status != 'removed'`];
    const whereParams = [req.scimOrgId];
    if (filter) {
        if (filter.attr === 'userName')   { whereParts.push('u.primary_email = ?');   whereParams.push(filter.value); }
        if (filter.attr === 'externalId') { whereParts.push('u.external_id = ?');     whereParams.push(filter.value); }
        if (filter.attr === 'active') {
            whereParts.push('m.status = ?');
            whereParams.push(filter.value ? 'active' : 'suspended');
        }
    }
    const fromClause = `FROM users u
         INNER JOIN org_memberships m
             ON m.user_id = u.id AND m.org_id = ?
         WHERE ${whereParts.join(' AND ')}`;

    const total = db(req).prepare(`SELECT COUNT(*) AS n ${fromClause}`).get(...whereParams)?.n ?? 0;

    const rows = db(req).prepare(`
        SELECT u.id, u.primary_email, u.display_name, u.external_id,
               u.created_at, u.updated_at, m.status AS membership_status
        ${fromClause}
        ORDER BY u.created_at ASC LIMIT ? OFFSET ?
    `).all(...whereParams, count, startIndex - 1);

    const mapped = rows.map(u => {
        u.status = u.membership_status === 'active' ? 'active' : 'suspended';
        return toScimUser(u, { orgId: req.scimOrgId, baseUrl: baseUrl(req) });
    });

    return res.type('application/scim+json').json({
        schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: total,
        startIndex,
        itemsPerPage: mapped.length,
        Resources:    mapped,
    });
});

// GET /Users/:id
router.get('/Users/:id', (req, res) => {
    const u = getUserForOrg(db(req), req.scimOrgId, req.params.id);
    if (!u) return scimError(res, 404, 'user not found in this org');
    return sendScimUser(req, res, u);
});

// PUT /Users/:id — replace the whole resource
router.put('/Users/:id', (req, res) => {
    const existing = getUserForOrg(db(req), req.scimOrgId, req.params.id);
    if (!existing) return scimError(res, 404, 'user not found in this org');
    let parsed;
    try { parsed = parseScimUserPayload(req.body || {}); }
    catch (err) { return scimError(res, 400, err.message, 'invalidValue'); }

    // ET-ENFORCE round-4 — owner-guard runs BEFORE any mutation. Round-3
    // sequenced this after the users-table UPDATE, which let an attacker
    // rewrite the owner's primary_email (then trigger a password reset for
    // a takeover) even when the active=false flip was correctly refused.
    // Owner lifecycle is dashboard-only; SCIM cannot touch owner identity.
    const ownerGuard = checkOwnerGuard(req, existing.id);
    if (ownerGuard) return scimError(res, 403, ownerGuard.reason);

    db(req).prepare(`
        UPDATE users SET primary_email = ?, display_name = ?, external_id = ?,
                         updated_at = datetime('now')
        WHERE id = ?
    `).run(parsed.email, parsed.displayName, parsed.externalId, existing.id);

    db(req).prepare(`
        UPDATE org_memberships SET status = ?, updated_at = datetime('now')
        WHERE org_id = ? AND user_id = ?
    `).run(parsed.active ? 'active' : 'suspended', req.scimOrgId, existing.id);

    emitAudit(req, 'scim.user.replaced', existing.id, { email: parsed.email });
    const after = getUserForOrg(db(req), req.scimOrgId, existing.id);
    return sendScimUser(req, res, after);
});

// PATCH /Users/:id
router.patch('/Users/:id', (req, res) => {
    const existing = getUserForOrg(db(req), req.scimOrgId, req.params.id);
    if (!existing) return scimError(res, 404, 'user not found in this org');
    // ET-ENFORCE round-4 — owner-guard FIRST, before any mutation. See PUT
    // handler comment above for the email-rewrite-then-password-reset
    // takeover the previous ordering allowed.
    const ownerGuard = checkOwnerGuard(req, existing.id);
    if (ownerGuard) return scimError(res, 403, ownerGuard.reason);

    const currentState = {
        email:       existing.primary_email,
        displayName: existing.display_name,
        externalId:  existing.external_id,
        active:      existing.status === 'active',
    };
    const next = applyScimPatch(currentState, req.body || {});

    db(req).prepare(`
        UPDATE users SET primary_email = ?, display_name = ?, external_id = ?,
                         updated_at = datetime('now')
        WHERE id = ?
    `).run(next.email, next.displayName ?? null, next.externalId ?? null, existing.id);

    db(req).prepare(`
        UPDATE org_memberships SET status = ?, updated_at = datetime('now')
        WHERE org_id = ? AND user_id = ?
    `).run(next.active ? 'active' : 'suspended', req.scimOrgId, existing.id);

    emitAudit(req, 'scim.user.patched', existing.id, { active: next.active });
    const after = getUserForOrg(db(req), req.scimOrgId, existing.id);
    return sendScimUser(req, res, after);
});

// DELETE /Users/:id — soft deprovision (remove membership, keep user row)
router.delete('/Users/:id', (req, res) => {
    const existing = getUserForOrg(db(req), req.scimOrgId, req.params.id);
    if (!existing) return scimError(res, 404, 'user not found in this org');
    const ownerGuard = checkOwnerGuard(req, existing.id);
    if (ownerGuard) {
        return scimError(res, 403, ownerGuard.reason);
    }
    db(req).prepare(`
        UPDATE org_memberships SET status = 'removed', updated_at = datetime('now')
        WHERE org_id = ? AND user_id = ?
    `).run(req.scimOrgId, existing.id);

    // ET-ENFORCE D — revoke the user's active session rows so the JWT refresh
    // flow fails immediately instead of waiting ~1h for the access token to
    // expire. Scoped to the SCIM-authenticated org: also revoke sessions with
    // no org context (general tokens that could carry this user anywhere),
    // but leave sessions tied to OTHER orgs intact (multi-tenant isolation).
    let revokedCount = 0;
    try {
        const result = db(req).prepare(`
            UPDATE sessions
               SET revoked_at = datetime('now')
             WHERE user_id = ?
               AND revoked_at IS NULL
               AND (org_id = ? OR org_id IS NULL)
        `).run(existing.id, req.scimOrgId);
        revokedCount = result.changes || 0;
    } catch (err) {
        // Sessions table missing in some legacy schemas → don't block
        // deprovision; log and continue.
        console.error('[scim] session revocation failed:', err.message);
    }

    emitAudit(req, 'scim.user.deprovisioned', existing.id, {});
    if (revokedCount > 0) {
        emitAudit(req, 'scim.user.sessions_revoked', existing.id, { count: revokedCount });
    }
    return res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// Groups (map to teams)
// ──────────────────────────────────────────────────────────────────────

function slugify(name) {
    return String(name).toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'team';
}

function uniqueSlug(database, orgId, baseSlug) {
    let slug = baseSlug;
    let suffix = 1;
    while (database.prepare(`SELECT id FROM teams WHERE org_id = ? AND slug = ?`).get(orgId, slug)) {
        suffix++;
        slug = `${baseSlug}-${suffix}`;
    }
    return slug;
}

function getTeamInOrg(database, orgId, teamId) {
    return database.prepare(
        `SELECT id, org_id, name, slug, created_at, updated_at
         FROM teams WHERE id = ? AND org_id = ?`,
    ).get(teamId, orgId);
}

function listMembers(database, teamId) {
    return database.prepare(`
        SELECT tm.user_id, u.primary_email
        FROM team_memberships tm
        INNER JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? AND tm.status = 'active'
        ORDER BY u.primary_email ASC
    `).all(teamId);
}

function setMembers(database, orgId, teamId, wantIds, actorId = 'scim_token') {
    // Only accept ids that are active org members — ignore strangers.
    const validRows = database.prepare(`
        SELECT user_id FROM org_memberships
        WHERE org_id = ? AND status = 'active'
    `).all(orgId);
    const validSet = new Set(validRows.map(r => r.user_id));
    const wantSet  = new Set(wantIds.filter(id => validSet.has(id)));

    const current = database.prepare(
        `SELECT user_id FROM team_memberships WHERE team_id = ? AND status = 'active'`,
    ).all(teamId).map(r => r.user_id);
    const currentSet = new Set(current);

    const toAdd    = [...wantSet].filter(id => !currentSet.has(id));
    const toRemove = [...currentSet].filter(id => !wantSet.has(id));

    const tx = database.transaction(() => {
        for (const uid of toAdd) {
            database.prepare(`
                INSERT INTO team_memberships (id, team_id, user_id, role, status)
                VALUES (?, ?, ?, 'member', 'active')
                ON CONFLICT(team_id, user_id) DO UPDATE SET status = 'active', updated_at = datetime('now')
            `).run(ulid(), teamId, uid);
        }
        for (const uid of toRemove) {
            database.prepare(`
                UPDATE team_memberships SET status = 'removed', updated_at = datetime('now')
                WHERE team_id = ? AND user_id = ?
            `).run(teamId, uid);
        }
    });
    tx();

    // Fire lifecycle events so Matrix / webhooks stay in sync. Fire
    // and forget — dispatch errors are swallowed by emitAndDispatch.
    for (const uid of toAdd) {
        emitAndDispatch(database, {
            orgId, teamId, eventType: 'team.member.joined',
            actorId, subjectUserId: uid, metadata: { via: 'scim' },
        });
    }
    for (const uid of toRemove) {
        emitAndDispatch(database, {
            orgId, teamId, eventType: 'team.member.left',
            actorId, subjectUserId: uid, metadata: { via: 'scim' },
        });
    }
}

// POST /Groups
router.post('/Groups', (req, res) => {
    let parsed;
    try { parsed = parseScimGroupPayload(req.body || {}); }
    catch (err) { return scimError(res, 400, err.message, 'invalidValue'); }

    const database = db(req);
    const id   = ulid();
    const slug = uniqueSlug(database, req.scimOrgId, slugify(parsed.displayName));

    database.prepare(`
        INSERT INTO teams (id, org_id, name, slug, settings_json)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, req.scimOrgId, parsed.displayName, slug, JSON.stringify({ provisioned_by: 'scim' }));

    setMembers(database, req.scimOrgId, id, parsed.memberIds);

    emitAudit(req, 'scim.group.provisioned', id, { displayName: parsed.displayName });
    emitAndDispatch(database, {
        orgId: req.scimOrgId, teamId: id,
        eventType: 'team.created', actorId: 'scim_token',
        metadata: { via: 'scim', name: parsed.displayName, slug },
    });

    const team = getTeamInOrg(database, req.scimOrgId, id);
    return res.type('application/scim+json')
              .status(201)
              .json(toScimGroup(team, listMembers(database, id), { baseUrl: baseUrl(req) }));
});

// GET /Groups
router.get('/Groups', (req, res) => {
    let filter = null;
    try { filter = parseScimFilter(req.query.filter, {
        allowedAttrs: ['displayName', 'externalId'],
    }); }
    catch (err) { return scimError(res, 400, err.message, 'invalidFilter'); }

    const startIndex = Math.max(parseInt(req.query.startIndex, 10) || 1, 1);
    const count      = Math.min(Math.max(parseInt(req.query.count, 10) || 100, 0), 200);

    const whereParts  = ['org_id = ?'];
    const whereParams = [req.scimOrgId];
    if (filter) {
        if (filter.op === 'eq' && filter.attr === 'displayName') {
            whereParts.push('name = ?');       whereParams.push(filter.value);
        } else if (filter.op === 'co' && filter.attr === 'displayName') {
            whereParts.push('name LIKE ?');    whereParams.push(`%${filter.value}%`);
        } else if (filter.op === 'sw' && filter.attr === 'displayName') {
            whereParts.push('name LIKE ?');    whereParams.push(`${filter.value}%`);
        } else if (filter.op === 'pr' && filter.attr === 'displayName') {
            whereParts.push('name IS NOT NULL AND name != \'\'');
        } else if (filter.op === 'and' || filter.op === 'or') {
            return scimError(res, 400, 'compound filters not yet supported on Groups');
        }
    }

    const where = whereParts.join(' AND ');
    const total = db(req).prepare(`SELECT COUNT(*) AS n FROM teams WHERE ${where}`).get(...whereParams)?.n ?? 0;
    const teams = db(req).prepare(`
        SELECT id, org_id, name, slug, created_at, updated_at
        FROM teams WHERE ${where}
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
    `).all(...whereParams, count, startIndex - 1);

    const mapped = teams.map(t =>
        toScimGroup(t, listMembers(db(req), t.id), { baseUrl: baseUrl(req) }),
    );

    return res.type('application/scim+json').json({
        schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        totalResults: total,
        startIndex,
        itemsPerPage: mapped.length,
        Resources:    mapped,
    });
});

// GET /Groups/:id
router.get('/Groups/:id', (req, res) => {
    const t = getTeamInOrg(db(req), req.scimOrgId, req.params.id);
    if (!t) return scimError(res, 404, 'group not found in this org');
    return res.type('application/scim+json')
              .json(toScimGroup(t, listMembers(db(req), t.id), { baseUrl: baseUrl(req) }));
});

// PUT /Groups/:id
router.put('/Groups/:id', (req, res) => {
    const t = getTeamInOrg(db(req), req.scimOrgId, req.params.id);
    if (!t) return scimError(res, 404, 'group not found in this org');
    let parsed;
    try { parsed = parseScimGroupPayload(req.body || {}); }
    catch (err) { return scimError(res, 400, err.message, 'invalidValue'); }

    db(req).prepare(`UPDATE teams SET name = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(parsed.displayName, t.id);
    setMembers(db(req), req.scimOrgId, t.id, parsed.memberIds);
    emitAudit(req, 'scim.group.replaced', t.id, { displayName: parsed.displayName });

    const after = getTeamInOrg(db(req), req.scimOrgId, t.id);
    return res.type('application/scim+json')
              .json(toScimGroup(after, listMembers(db(req), t.id), { baseUrl: baseUrl(req) }));
});

// PATCH /Groups/:id
router.patch('/Groups/:id', (req, res) => {
    const t = getTeamInOrg(db(req), req.scimOrgId, req.params.id);
    if (!t) return scimError(res, 404, 'group not found in this org');

    const currentIds = listMembers(db(req), t.id).map(m => m.user_id);
    const nextState  = applyScimGroupPatch(
        { displayName: t.name, memberIds: currentIds },
        req.body || {},
    );

    if (nextState.displayName !== t.name) {
        db(req).prepare(`UPDATE teams SET name = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(nextState.displayName, t.id);
    }
    setMembers(db(req), req.scimOrgId, t.id, nextState.memberIds);
    emitAudit(req, 'scim.group.patched', t.id, {});

    const after = getTeamInOrg(db(req), req.scimOrgId, t.id);
    return res.type('application/scim+json')
              .json(toScimGroup(after, listMembers(db(req), t.id), { baseUrl: baseUrl(req) }));
});

// DELETE /Groups/:id
router.delete('/Groups/:id', (req, res) => {
    const t = getTeamInOrg(db(req), req.scimOrgId, req.params.id);
    if (!t) return scimError(res, 404, 'group not found in this org');

    db(req).transaction(() => {
        db(req).prepare(`DELETE FROM team_memberships WHERE team_id = ?`).run(t.id);
        db(req).prepare(`DELETE FROM teams WHERE id = ?`).run(t.id);
    })();
    emitAudit(req, 'scim.group.deleted', t.id, { displayName: t.name });
    emitAndDispatch(db(req), {
        orgId: req.scimOrgId, teamId: t.id,
        eventType: 'team.archived', actorId: 'scim_token',
        metadata: { via: 'scim', name: t.name },
    });
    return res.status(204).end();
});

export default router;
