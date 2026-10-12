/**
 * ET-6A — agent + tool RBAC.
 *
 * Decision model (default-permissive, admin-adds-rules):
 *   - If no rule matches → allowed (default).
 *   - The most-specific scope rule wins per (role, agent) pair. Rules
 *     with a concrete scope_id beat an org-wide rule (scope_id=NULL).
 *     This lets an admin deny an agent org-wide but re-enable it in a
 *     specific team, or vice-versa.
 *   - ACROSS roles, the policy is union-permissive: if ANY of the
 *     user's roles finally resolves to allowed=true, the user wins.
 *     Otherwise, if any role resolves to allowed=false, the user is
 *     denied (and the reason cites that role).
 *
 * Tools have no scope dimension yet — they're either allowed to the
 * role or not.
 */

import { ulid } from './helpers.js';

// SQLite treats NULL as distinct from NULL under UNIQUE, so we use an
// empty string as the "no scope" sentinel in the index column.
const NO_SCOPE = '';

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureAgentRbacSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_role_permissions (
            id          TEXT PRIMARY KEY,
            role_id     TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
            agent_id    TEXT NOT NULL,
            scope_id    TEXT NOT NULL DEFAULT '',
            allowed     INTEGER NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(role_id, agent_id, scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_role_perms_lookup
            ON agent_role_permissions(role_id, agent_id);

        CREATE TABLE IF NOT EXISTS tool_role_permissions (
            id          TEXT PRIMARY KEY,
            role_id     TEXT NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
            tool_id     TEXT NOT NULL,
            allowed     INTEGER NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(role_id, tool_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tool_role_perms_lookup
            ON tool_role_permissions(role_id, tool_id);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// Agent permissions
// ──────────────────────────────────────────────────────────────────────

export function setAgentAccess(db, { roleId, agentId, scopeId = null, allowed }) {
    if (!roleId || !agentId) throw new Error('roleId + agentId required');
    if (typeof allowed !== 'boolean') throw new Error('allowed must be boolean');
    const scopeKey = scopeId || NO_SCOPE;
    db.prepare(`
        INSERT INTO agent_role_permissions (id, role_id, agent_id, scope_id, allowed)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(role_id, agent_id, scope_id) DO UPDATE SET allowed = excluded.allowed
    `).run(ulid(), roleId, agentId, scopeKey, allowed ? 1 : 0);
}

export function clearAgentAccess(db, { roleId, agentId, scopeId = null }) {
    const scopeKey = scopeId || NO_SCOPE;
    db.prepare(
        `DELETE FROM agent_role_permissions WHERE role_id = ? AND agent_id = ? AND scope_id = ?`,
    ).run(roleId, agentId, scopeKey);
}

export function listAgentAccess(db, { roleId }) {
    return db.prepare(`
        SELECT id, role_id, agent_id, scope_id, allowed, created_at
        FROM agent_role_permissions
        WHERE role_id = ?
        ORDER BY agent_id ASC, scope_id ASC
    `).all(roleId).map(r => ({
        ...r,
        scope_id: r.scope_id === NO_SCOPE ? null : r.scope_id,
        allowed:  !!r.allowed,
    }));
}

/**
 * Pick the matching rule for a single role. Preference: concrete
 * scope match > org-wide rule. Returns undefined if no rule applies.
 */
function pickAgentRule(db, roleId, agentId, scopeId) {
    const scopeKey = scopeId || NO_SCOPE;
    if (scopeKey !== NO_SCOPE) {
        const specific = db.prepare(`
            SELECT role_id, agent_id, scope_id, allowed
            FROM agent_role_permissions
            WHERE role_id = ? AND agent_id = ? AND scope_id = ?
        `).get(roleId, agentId, scopeKey);
        if (specific) return { ...specific, allowed: !!specific.allowed };
    }
    const orgWide = db.prepare(`
        SELECT role_id, agent_id, scope_id, allowed
        FROM agent_role_permissions
        WHERE role_id = ? AND agent_id = ? AND scope_id = ?
    `).get(roleId, agentId, NO_SCOPE);
    if (orgWide) return { ...orgWide, allowed: !!orgWide.allowed };
    return undefined;
}

export function canUseAgent(db, { roleIds = [], agentId, scopeId = null }) {
    if (!agentId) throw new Error('agentId required');
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
        return { allowed: true, reason: 'default' };
    }
    let sawDeny = null;
    for (const roleId of roleIds) {
        const rule = pickAgentRule(db, roleId, agentId, scopeId);
        if (!rule) continue;
        if (rule.allowed) {
            return { allowed: true, reason: 'allow_rule', role_id: roleId, scope_id: rule.scope_id === NO_SCOPE ? null : rule.scope_id };
        }
        sawDeny = sawDeny || { role_id: roleId, scope_id: rule.scope_id === NO_SCOPE ? null : rule.scope_id };
    }
    if (sawDeny) {
        return { allowed: false, reason: 'deny_rule', ...sawDeny };
    }
    return { allowed: true, reason: 'default' };
}

// ──────────────────────────────────────────────────────────────────────
// Tool permissions
// ──────────────────────────────────────────────────────────────────────

export function setToolAccess(db, { roleId, toolId, allowed }) {
    if (!roleId || !toolId) throw new Error('roleId + toolId required');
    if (typeof allowed !== 'boolean') throw new Error('allowed must be boolean');
    db.prepare(`
        INSERT INTO tool_role_permissions (id, role_id, tool_id, allowed)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(role_id, tool_id) DO UPDATE SET allowed = excluded.allowed
    `).run(ulid(), roleId, toolId, allowed ? 1 : 0);
}

export function clearToolAccess(db, { roleId, toolId }) {
    db.prepare(`DELETE FROM tool_role_permissions WHERE role_id = ? AND tool_id = ?`).run(roleId, toolId);
}

export function listToolAccess(db, { roleId }) {
    return db.prepare(`
        SELECT id, role_id, tool_id, allowed, created_at
        FROM tool_role_permissions
        WHERE role_id = ?
        ORDER BY tool_id ASC
    `).all(roleId).map(r => ({ ...r, allowed: !!r.allowed }));
}

export function canUseTool(db, { roleIds = [], toolId }) {
    if (!toolId) throw new Error('toolId required');
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
        return { allowed: true, reason: 'default' };
    }
    let sawDeny = null;
    for (const roleId of roleIds) {
        const rule = db.prepare(`
            SELECT allowed FROM tool_role_permissions
            WHERE role_id = ? AND tool_id = ?
        `).get(roleId, toolId);
        if (!rule) continue;
        if (rule.allowed) {
            return { allowed: true, reason: 'allow_rule', role_id: roleId };
        }
        sawDeny = sawDeny || { role_id: roleId };
    }
    if (sawDeny) return { allowed: false, reason: 'deny_rule', ...sawDeny };
    return { allowed: true, reason: 'default' };
}
