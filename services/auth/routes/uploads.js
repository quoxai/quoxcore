/**
 * File upload routes for Quox Auth Service
 *
 * Handles file uploads for organization logos and other assets.
 * Files are stored locally in the uploads directory.
 *
 * POST /uploads/org/:orgId/logo - Upload organization logo
 * GET  /uploads/:filename - Serve uploaded file (handled by static middleware)
 */

import { Router } from 'express';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import path, { join, extname, basename, resolve } from 'path';
import multer from 'multer';
import { generateId } from '../utils/crypto.js';
import { queries, getDb } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { hasRoleLevel, OrgRoles } from '../utils/policy.js';
import { apiLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Upload directory - configurable via environment
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/var/lib/quox/uploads';

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
}

// Allowed image types
const ALLOWED_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
};

// Max file size (2MB)
const MAX_SIZE = 2 * 1024 * 1024;

/**
 * Configure multer for secure file uploads (Issue 1.3 fix)
 * Replaces custom multipart parser that had no size limits
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_SIZE,  // 2MB limit
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_TYPES[file.mimetype]) {
            cb(null, true);
        } else {
            cb(new Error(`File type not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`));
        }
    }
});

/**
 * Validate filename is safe (no path traversal) - Issue 1.2 fix
 * @param {string} filename - Filename to validate
 * @returns {string|null} - Safe filename or null if invalid
 */
function getSafeFilename(filename) {
    if (!filename) return null;

    // Extract just the filename using path.basename
    const safeName = basename(filename);

    // Reject if contains path traversal attempts
    if (safeName.includes('..') || safeName.includes('/') || safeName.includes('\\')) {
        console.error('[SECURITY] Path traversal attempt blocked:', filename);
        return null;
    }

    // Reject if empty after sanitization
    if (!safeName || safeName === '.' || safeName === '..') {
        return null;
    }

    return safeName;
}

/**
 * Verify path is within allowed directory - Issue 1.2 fix
 * @param {string} filepath - Full file path to validate
 * @param {string} allowedDir - Directory the file must be within
 * @returns {boolean}
 */
function isPathWithinDir(filepath, allowedDir) {
    const resolvedPath = resolve(filepath);
    const resolvedDir = resolve(allowedDir);
    return resolvedPath.startsWith(resolvedDir + path.sep) || resolvedPath === resolvedDir;
}

/**
 * POST /uploads/org/:orgId/logo
 * Upload organization logo
 * Issue 1.3: Uses multer with size limits instead of custom parser
 * Issue 1.2: Uses safe path validation for old logo deletion
 */
router.post('/org/:orgId/logo', apiLimiter, authenticate(), upload.single('logo'), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required to upload logo'
            });
        }

        // Multer already validated file type and size via fileFilter and limits
        if (!req.file) {
            return res.status(400).json({
                error: 'no_file',
                message: 'No file uploaded'
            });
        }

        // Generate unique filename
        const ext = ALLOWED_TYPES[req.file.mimetype];
        const filename = `org-${orgId}-logo-${generateId().slice(-8)}${ext}`;
        const filepath = join(UPLOAD_DIR, filename);

        // Delete old logo if exists - Issue 1.2: Safe path handling
        const org = queries.getOrgById(orgId);
        if (org?.logo_url) {
            const oldFilename = getSafeFilename(org.logo_url.split('/').pop());
            if (oldFilename) {
                const oldPath = join(UPLOAD_DIR, oldFilename);
                // Verify path is within UPLOAD_DIR before deletion
                if (isPathWithinDir(oldPath, UPLOAD_DIR) && existsSync(oldPath)) {
                    try {
                        unlinkSync(oldPath);
                    } catch (e) {
                        console.warn('Failed to delete old logo:', e.message);
                    }
                }
            }
        }

        // Save file
        writeFileSync(filepath, req.file.buffer);

        // Update org with new logo URL
        const logoUrl = `/uploads/${filename}`;
        const db = getDb();
        db.prepare(`
            UPDATE orgs SET logo_url = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(logoUrl, orgId);

        console.log(`Uploaded logo for org ${orgId}: ${filename} (${req.file.buffer.length} bytes)`);

        res.json({
            success: true,
            logo_url: logoUrl,
            filename
        });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({
            error: 'upload_failed',
            message: err.message || 'Failed to upload file'
        });
    }
});

/**
 * POST /uploads/me/avatar
 * Upload the authenticated user's profile avatar. Mirrors the org logo
 * pattern above: multer-validated image into UPLOAD_DIR, old file removed,
 * users.avatar_url updated to the served /uploads/<filename> path. This is
 * the canonical human avatar store; the Matrix profile mirrors it at the
 * next Matrix login (see routes/matrix-sso.js and src/services/matrixClient.js).
 */
router.post('/me/avatar', apiLimiter, authenticate(), upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'no_file',
                message: 'No file uploaded'
            });
        }

        const ext = ALLOWED_TYPES[req.file.mimetype];
        const filename = `user-${req.user.id}-avatar-${generateId().slice(-8)}${ext}`;
        const filepath = join(UPLOAD_DIR, filename);

        // Delete the previous avatar file if it lives in UPLOAD_DIR
        const db = getDb();
        const existing = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
        if (existing?.avatar_url?.startsWith('/uploads/')) {
            const oldFilename = getSafeFilename(existing.avatar_url.split('/').pop());
            if (oldFilename) {
                const oldPath = join(UPLOAD_DIR, oldFilename);
                if (isPathWithinDir(oldPath, UPLOAD_DIR) && existsSync(oldPath)) {
                    try {
                        unlinkSync(oldPath);
                    } catch (e) {
                        console.warn('Failed to delete old avatar:', e.message);
                    }
                }
            }
        }

        writeFileSync(filepath, req.file.buffer);

        const avatarUrl = `/uploads/${filename}`;
        db.prepare(`
            UPDATE users SET avatar_url = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(avatarUrl, req.user.id);

        console.log(`Uploaded avatar for user ${req.user.id}: ${filename} (${req.file.buffer.length} bytes)`);

        res.json({
            success: true,
            avatar_url: avatarUrl,
            filename
        });

    } catch (err) {
        console.error('Avatar upload error:', err);
        res.status(500).json({
            error: 'upload_failed',
            message: err.message || 'Failed to upload avatar'
        });
    }
});

/**
 * DELETE /uploads/me/avatar
 * Remove the authenticated user's profile avatar.
 */
router.delete('/me/avatar', authenticate(), async (req, res) => {
    try {
        const db = getDb();
        const existing = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id);
        if (existing?.avatar_url?.startsWith('/uploads/')) {
            const filename = getSafeFilename(existing.avatar_url.split('/').pop());
            if (filename) {
                const filepath = join(UPLOAD_DIR, filename);
                if (isPathWithinDir(filepath, UPLOAD_DIR) && existsSync(filepath)) {
                    try {
                        unlinkSync(filepath);
                    } catch (e) {
                        console.warn('Failed to delete avatar file:', e.message);
                    }
                }
            }
        }

        db.prepare(`
            UPDATE users SET avatar_url = NULL, updated_at = datetime('now')
            WHERE id = ?
        `).run(req.user.id);

        res.json({
            success: true,
            message: 'Avatar removed'
        });

    } catch (err) {
        console.error('Avatar delete error:', err);
        res.status(500).json({
            error: 'delete_failed',
            message: 'Failed to remove avatar'
        });
    }
});

/**
 * DELETE /uploads/org/:orgId/logo
 * Remove organization logo
 * Issue 1.2: Uses safe path validation
 */
router.delete('/org/:orgId/logo', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Admin role required to delete logo'
            });
        }

        // Get current logo - Issue 1.2: Safe path handling
        const org = queries.getOrgById(orgId);
        if (org?.logo_url) {
            const filename = getSafeFilename(org.logo_url.split('/').pop());
            if (filename) {
                const filepath = join(UPLOAD_DIR, filename);
                // Verify path is within UPLOAD_DIR before deletion
                if (isPathWithinDir(filepath, UPLOAD_DIR) && existsSync(filepath)) {
                    unlinkSync(filepath);
                }
            }
        }

        // Clear logo URL in database
        const db = getDb();
        db.prepare(`
            UPDATE orgs SET logo_url = NULL, updated_at = datetime('now')
            WHERE id = ?
        `).run(orgId);

        res.json({
            success: true,
            message: 'Logo removed'
        });

    } catch (err) {
        console.error('Delete logo error:', err);
        res.status(500).json({
            error: 'delete_failed',
            message: 'Failed to delete logo'
        });
    }
});

// Export router and upload directory for static serving
export { UPLOAD_DIR };
export default router;
