/**
 * Seller routes for Marketplace (Stream 2: Developer Portal)
 *
 * POST   /orgs/:orgId/sellers     — register as seller (ADMIN+)
 * GET    /orgs/:orgId/sellers/me  — get own seller profile (VIEWER+)
 * PATCH  /orgs/:orgId/sellers/me  — update seller profile (ADMIN+)
 * GET    /sellers/:slug           — public seller profile (no auth)
 */

import { Router } from 'express';
import { generateId } from '../utils/crypto.js';
import { queries, getDb } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { hasRoleLevel, OrgRoles } from '../utils/policy.js';
import { logOrgEvent, AuditActions } from '../utils/audit.js';
import {
    createSeller, getSellerByOrgId, getSellerBySlug, updateSeller
} from '../db/marketplace.js';

const router = Router();

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

/**
 * POST /orgs/:orgId/sellers — register as seller
 */
router.post('/orgs/:orgId/sellers', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { display_name, github_username, bio, website } = req.body;

        // Check admin permissions
        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
        }

        // Check if already registered
        const existing = getSellerByOrgId(orgId);
        if (existing) {
            return res.status(409).json({ error: 'already_exists', message: 'Organisation already has a seller profile' });
        }

        if (!display_name || display_name.length < 2 || display_name.length > 100) {
            return res.status(400).json({ error: 'validation_error', message: 'Display name must be 2-100 characters' });
        }
        if (bio && bio.length > 2000) {
            return res.status(400).json({ error: 'validation_error', message: 'Bio must be under 2000 characters' });
        }
        if (website && (website.length > 500 || !/^https?:\/\//.test(website))) {
            return res.status(400).json({ error: 'validation_error', message: 'Website must be a valid HTTP(S) URL under 500 characters' });
        }
        if (github_username && (github_username.length > 39 || !/^[a-zA-Z0-9-]+$/.test(github_username))) {
            return res.status(400).json({ error: 'validation_error', message: 'GitHub username must be alphanumeric + hyphens, max 39 characters' });
        }

        // Generate unique slug
        let slug = generateSlug(display_name);
        const existingSeller = getSellerBySlug(slug);
        if (existingSeller) {
            slug = `${slug}-${generateId().slice(-6).toLowerCase()}`;
        }

        const seller = createSeller({
            org_id: orgId,
            display_name,
            slug,
            github_username: github_username || null,
            bio: bio || null,
            website: website || null,
            created_by: req.user.id
        });

        logOrgEvent('marketplace.seller_register', { type: 'user', id: req.user.id }, orgId, req, {
            seller_id: seller.id, slug
        });

        res.status(201).json({ success: true, seller });
    } catch (err) {
        console.error('Create seller error:', err);
        res.status(500).json({ error: 'create_failed', message: 'Failed to register as seller' });
    }
});

/**
 * GET /orgs/:orgId/sellers/me — get own seller profile
 */
router.get('/orgs/:orgId/sellers/me', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        const seller = getSellerByOrgId(orgId);
        if (!seller) {
            return res.status(404).json({ error: 'not_found', message: 'No seller profile for this organisation' });
        }

        res.json({ seller });
    } catch (err) {
        console.error('Get seller error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch seller profile' });
    }
});

/**
 * PATCH /orgs/:orgId/sellers/me — update seller profile
 */
router.patch('/orgs/:orgId/sellers/me', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
        }

        const seller = getSellerByOrgId(orgId);
        if (!seller) {
            return res.status(404).json({ error: 'not_found', message: 'No seller profile for this organisation' });
        }

        // If slug is being changed, validate format and check uniqueness
        if (req.body.slug && req.body.slug !== seller.slug) {
            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(req.body.slug) || req.body.slug.length > 50) {
                return res.status(400).json({ error: 'validation_error', message: 'Slug must be lowercase alphanumeric + hyphens, 2-50 chars' });
            }
            const slugTaken = getSellerBySlug(req.body.slug);
            if (slugTaken) {
                return res.status(409).json({ error: 'slug_taken', message: 'Slug already in use' });
            }
        }

        const updated = updateSeller(seller.id, req.body);

        logOrgEvent('marketplace.seller_update', { type: 'user', id: req.user.id }, orgId, req, {
            seller_id: seller.id, fields: Object.keys(req.body)
        });

        res.json({ success: true, seller: updated });
    } catch (err) {
        console.error('Update seller error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update seller profile' });
    }
});

/**
 * GET /sellers/:slug — public seller profile (no auth)
 */
router.get('/sellers/:slug', async (req, res) => {
    try {
        const seller = getSellerBySlug(req.params.slug);
        if (!seller) {
            return res.status(404).json({ error: 'not_found', message: 'Seller not found' });
        }

        // Return public-safe fields only
        res.json({
            seller: {
                id: seller.id,
                display_name: seller.display_name,
                slug: seller.slug,
                trust_level: seller.trust_level,
                github_username: seller.github_username,
                bio: seller.bio,
                website: seller.website,
                logo_path: seller.logo_path,
                created_at: seller.created_at
            }
        });
    } catch (err) {
        console.error('Public seller error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch seller profile' });
    }
});

export default router;
