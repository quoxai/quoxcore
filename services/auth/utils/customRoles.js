/**
 * ET-4 Phase A — Custom roles.
 *
 * Enterprise-tier feature: define org-specific roles that bundle
 * capabilities. A membership stays on a built-in role as its base
 * (owner/admin/builder/runner/viewer/auditor) and can additionally
 * carry a custom role that *adds* capabilities on top.
 *
 * Schema:
 *   custom_roles            (id, org_id, slug, name, description, created_by,
 *                            created_at, deleted_at)
 *   custom_role_capabilities (id, role_id, capability, scope_id)
 *
 * Resolution order at request time:
 *   1. Built-in role → capabilities (from policy.js)
 *   2. Custom role (if any) → capabilities from custom_role_capabilities
 *   3. Union, deduplicated.
 */

import { ulid } from './helpers.js';
import { getCapabilities } from './policy.js';

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureCustomRolesSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS custom_roles (
            id          TEXT PRIMARY KEY,
            org_id      TEXT NOT NULL,
            slug        TEXT NOT NULL,
            name        TEXT NOT NULL,
            description TEXT,
            created_by  TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            deleted_at  TEXT,
            UNIQUE(org_id, slug)
        );
        CREATE INDEX IF NOT EXISTS idx_custom_roles_org
            ON custom_roles(org_id, deleted_at);

        CREATE TABLE IF NOT EXISTS custom_role_capabilities (
            id         TEXT PRIMARY KEY,
            role_id    TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
            capability TEXT NOT NULL,
            scope_id   TEXT,
            UNIQUE(role_id, capability, scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_custom_role_caps_role
            ON custom_role_capabilities(role_id);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function createCustomRole(db, orgId, { slug, name, description, createdBy }) {
    if (!orgId) throw new Error('createCustomRole: orgId required');
    if (!slug || typeof slug !== 'string' || !SLUG_RE.test(slug)) {
        throw new Error(`createCustomRole: invalid slug "${slug}" (lowercase, alphanumeric + hyphen, 1-64 chars)`);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw new Error('createCustomRole: name required');
    }
    const id = ulid();
    db.prepare(`
        INSERT INTO custom_roles (id, org_id, slug, name, description, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, slug, name.trim(), description || null, createdBy || null);
    return getCustomRole(db, orgId, id);
}

export function getCustomRole(db, orgId, roleId) {
    if (!roleId) return null;
    return db.prepare(`
        SELECT id, org_id, slug, name, description, created_by, created_at
        FROM custom_roles
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
    `).get(roleId, orgId) || null;
}

export function listCustomRoles(db, orgId) {
    const rows = db.prepare(`
        SELECT r.id, r.org_id, r.slug, r.name, r.description, r.created_by, r.created_at,
               (SELECT COUNT(*) FROM custom_role_capabilities WHERE role_id = r.id) AS capability_count
        FROM custom_roles r
        WHERE r.org_id = ? AND r.deleted_at IS NULL
        ORDER BY r.created_at ASC
    `).all(orgId);
    return rows;
}

export function deleteCustomRole(db, orgId, roleId) {
    if (!roleId) return;
    db.prepare(`
        UPDATE custom_roles
        SET deleted_at = datetime('now')
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
    `).run(roleId, orgId);
}

// ──────────────────────────────────────────────────────────────────────
// Capabilities
// ──────────────────────────────────────────────────────────────────────

// scope_id storage uses an empty string sentinel for "org-wide" rather
// than NULL. SQLite's UNIQUE treats NULL as distinct, which would let
// duplicate org-wide grants slip past ON CONFLICT. Reads normalise back
// to null in the returned row.
const ORG_WIDE = '';

export function grantRoleCapability(db, roleId, capability, scopeId = null) {
    if (!roleId)     throw new Error('grantRoleCapability: roleId required');
    if (!capability) throw new Error('grantRoleCapability: capability required');
    const scopeKey = scopeId || ORG_WIDE;
    db.prepare(`
        INSERT INTO custom_role_capabilities (id, role_id, capability, scope_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(role_id, capability, scope_id) DO NOTHING
    `).run(ulid(), roleId, capability, scopeKey);
}

export function revokeRoleCapability(db, roleId, capability, scopeId = null) {
    if (!roleId || !capability) return;
    const scopeKey = scopeId || ORG_WIDE;
    db.prepare(`
        DELETE FROM custom_role_capabilities
        WHERE role_id = ? AND capability = ? AND scope_id = ?
    `).run(roleId, capability, scopeKey);
}

export function getCustomRoleCapabilities(db, roleId) {
    if (!roleId) return [];
    const rows = db.prepare(`
        SELECT capability, scope_id
        FROM custom_role_capabilities
        WHERE role_id = ?
        ORDER BY capability ASC
    `).all(roleId);
    // Normalise sentinel back to null for callers.
    return rows.map(r => ({ ...r, scope_id: r.scope_id === ORG_WIDE ? null : r.scope_id }));
}

// ──────────────────────────────────────────────────────────────────────
// Resolver — merges built-in role + custom role capabilities
// ──────────────────────────────────────────────────────────────────────

export function resolveCapabilitiesForMembership(db, orgId, { role, customRoleId }) {
    const builtIn = Array.isArray(getCapabilities(role)) ? [...getCapabilities(role)] : [];
    const set = new Set(builtIn);

    if (customRoleId) {
        // Only honour custom role if it belongs to the same org.
        const role = getCustomRole(db, orgId, customRoleId);
        if (role) {
            const caps = getCustomRoleCapabilities(db, customRoleId);
            for (const { capability } of caps) {
                set.add(capability);
            }
        }
    }

    return [...set];
}
