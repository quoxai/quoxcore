/**
 * Instance Admin middleware for Quox Auth Service
 * Separates instance-level admin from org-level admin
 */

import { getDb } from '../db/index.js';

// Role hierarchy
const ROLE_LEVELS = {
    superadmin: 3,
    admin: 2,
    readonly: 1
};

/**
 * Check if a user is an instance admin
 * @param {string} userId
 * @returns {{ isAdmin: boolean, role?: string }}
 */
export function checkInstanceAdmin(userId) {
    const db = getDb();
    const admin = db.prepare(`
        SELECT role FROM instance_admins
        WHERE user_id = ? AND revoked_at IS NULL
    `).get(userId);

    if (!admin) {
        return { isAdmin: false };
    }

    return { isAdmin: true, role: admin.role };
}

/**
 * Middleware: Require instance admin access
 * @param {string} minRole - Minimum required role: 'readonly', 'admin', 'superadmin'
 */
export function requireInstanceAdmin(minRole = 'admin') {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'authentication_required',
                message: 'Must be authenticated'
            });
        }

        const { isAdmin, role } = checkInstanceAdmin(req.user.id);

        if (!isAdmin) {
            return res.status(403).json({
                error: 'instance_admin_required',
                message: 'Instance administrator access required'
            });
        }

        const userLevel = ROLE_LEVELS[role] || 0;
        const requiredLevel = ROLE_LEVELS[minRole] || 0;

        if (userLevel < requiredLevel) {
            return res.status(403).json({
                error: 'insufficient_admin_role',
                message: `Requires ${minRole} role or higher`
            });
        }

        // Add admin info to request
        req.instanceAdmin = { role };
        next();
    };
}

/**
 * Check if this is the first user (for initial setup)
 * @returns {boolean}
 */
export function isFirstUser() {
    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM users').get();
    return result.count === 0;
}

/**
 * Check if any instance admin exists
 * @returns {boolean}
 */
export function hasInstanceAdmin() {
    const db = getDb();
    const result = db.prepare(`
        SELECT COUNT(*) as count FROM instance_admins WHERE revoked_at IS NULL
    `).get();
    return result.count > 0;
}

/**
 * Grant instance admin role to a user
 * @param {string} userId - User to grant admin
 * @param {string} role - Role to grant
 * @param {string} grantedBy - User granting the role
 */
export function grantInstanceAdmin(userId, role, grantedBy) {
    const db = getDb();
    const { generateId } = require('../utils/crypto.js');

    // Check if already an admin
    const existing = db.prepare(`
        SELECT id, role FROM instance_admins WHERE user_id = ?
    `).get(userId);

    if (existing) {
        if (existing.role === role) {
            return { success: false, message: 'User already has this admin role' };
        }
        // Update role
        db.prepare(`
            UPDATE instance_admins
            SET role = ?, revoked_at = NULL, granted_by = ?, granted_at = datetime('now')
            WHERE user_id = ?
        `).run(role, grantedBy, userId);
        return { success: true, action: 'updated' };
    }

    // Create new admin
    db.prepare(`
        INSERT INTO instance_admins (id, user_id, role, granted_by)
        VALUES (?, ?, ?, ?)
    `).run(generateId(), userId, role, grantedBy);

    return { success: true, action: 'created' };
}

/**
 * Revoke instance admin role
 * @param {string} userId - User to revoke
 * @param {string} revokedBy - User revoking the role
 */
export function revokeInstanceAdmin(userId, revokedBy) {
    const db = getDb();

    // Can't revoke yourself
    if (userId === revokedBy) {
        return { success: false, message: 'Cannot revoke your own admin access' };
    }

    // Check there's at least one other superadmin
    const superadmins = db.prepare(`
        SELECT user_id FROM instance_admins
        WHERE role = 'superadmin' AND revoked_at IS NULL AND user_id != ?
    `).all(userId);

    const target = db.prepare(`
        SELECT role FROM instance_admins WHERE user_id = ? AND revoked_at IS NULL
    `).get(userId);

    if (target?.role === 'superadmin' && superadmins.length === 0) {
        return { success: false, message: 'Cannot revoke the last superadmin' };
    }

    db.prepare(`
        UPDATE instance_admins SET revoked_at = datetime('now') WHERE user_id = ?
    `).run(userId);

    return { success: true };
}

/**
 * Handle first user setup - make them superadmin
 * @param {string} userId
 */
export function handleFirstUserSetup(userId) {
    if (!hasInstanceAdmin()) {
        grantInstanceAdmin(userId, 'superadmin', userId);
        return { isFirstAdmin: true };
    }
    return { isFirstAdmin: false };
}

/**
 * List all instance admins
 */
export function listInstanceAdmins() {
    const db = getDb();
    return db.prepare(`
        SELECT ia.id, ia.user_id, ia.role, ia.granted_at,
               u.primary_email, u.display_name,
               g.display_name as granted_by_name
        FROM instance_admins ia
        JOIN users u ON ia.user_id = u.id
        LEFT JOIN users g ON ia.granted_by = g.id
        WHERE ia.revoked_at IS NULL
        ORDER BY ia.role DESC, ia.granted_at ASC
    `).all();
}

export default {
    checkInstanceAdmin,
    requireInstanceAdmin,
    isFirstUser,
    hasInstanceAdmin,
    grantInstanceAdmin,
    revokeInstanceAdmin,
    handleFirstUserSetup,
    listInstanceAdmins
};
