/**
 * Listing routes for Marketplace (Stream 2: Developer Portal)
 *
 * POST   /orgs/:orgId/listings                       — create draft (BUILDER+)
 * GET    /orgs/:orgId/listings                       — list own (VIEWER+)
 * GET    /orgs/:orgId/listings/:id                   — detail (VIEWER+)
 * PATCH  /orgs/:orgId/listings/:id                   — update (BUILDER+)
 * DELETE /orgs/:orgId/listings/:id                   — soft delete (ADMIN+)
 * POST   /orgs/:orgId/listings/:id/versions          — upload + Gate 1 (BUILDER+)
 * GET    /orgs/:orgId/listings/:id/versions           — list versions (VIEWER+)
 * PATCH  /orgs/:orgId/listings/:id/versions/:vid/yank — yank version (ADMIN+)
 * GET    /marketplace/listings                        — public browse (no auth)
 * GET    /marketplace/listings/:slug                  — public detail (no auth)
 */

import { Router } from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { generateId } from '../utils/crypto.js';
import { queries, getDb } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { hasRoleLevel, OrgRoles } from '../utils/policy.js';
import { logOrgEvent } from '../utils/audit.js';
import {
    getSellerByOrgId, createListing, getListingById, getListingBySlug,
    getListingsByOrg, getPublishedListings, updateListing, updateListingStatus,
    softDeleteListing, createListingVersion, getVersionsByListing, updateVersionStatus,
    getScreenshotsByListing
} from '../db/marketplace.js';
import { runReviewGate } from '../services/pluginReviewGate.js';

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/var/lib/quox/uploads';
const MARKETPLACE_DIR = join(UPLOAD_DIR, 'marketplace');

// Ensure marketplace upload directory exists
if (!existsSync(MARKETPLACE_DIR)) {
    mkdirSync(MARKETPLACE_DIR, { recursive: true });
}

// Multer for .quoxplugin ZIP uploads (5MB limit)
const pluginUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const allowed = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
        if (allowed.includes(file.mimetype) || file.originalname.endsWith('.quoxplugin') || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .quoxplugin (ZIP) files are allowed'));
        }
    }
});

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

// ============================================================================
// Org-scoped routes (authenticated)
// ============================================================================

/**
 * POST /orgs/:orgId/listings — create draft listing
 */
router.post('/orgs/:orgId/listings', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { title, description, product_type, price_cents, price_model, category, tags } = req.body;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.BUILDER)) {
            return res.status(403).json({ error: 'forbidden', message: 'Builder role required' });
        }

        const seller = getSellerByOrgId(orgId);
        if (!seller) {
            return res.status(400).json({ error: 'not_seller', message: 'Organisation must register as a seller first' });
        }

        if (!title || title.length < 3 || title.length > 200) {
            return res.status(400).json({ error: 'validation_error', message: 'Title must be 3-200 characters' });
        }
        if (description && description.length > 5000) {
            return res.status(400).json({ error: 'validation_error', message: 'Description must be under 5000 characters' });
        }
        const validProductTypes = ['plugin', 'workflow', 'agent', 'agent_team', 'community'];
        if (product_type && !validProductTypes.includes(product_type)) {
            return res.status(400).json({ error: 'validation_error', message: `Product type must be one of: ${validProductTypes.join(', ')}` });
        }
        const validPriceModels = ['free', 'one_time', 'subscription_monthly', 'subscription_yearly'];
        if (price_model && !validPriceModels.includes(price_model)) {
            return res.status(400).json({ error: 'validation_error', message: `Price model must be one of: ${validPriceModels.join(', ')}` });
        }
        if (price_cents !== undefined && (typeof price_cents !== 'number' || price_cents < 0)) {
            return res.status(400).json({ error: 'validation_error', message: 'Price must be a non-negative number' });
        }
        if (tags && Array.isArray(tags) && tags.length > 20) {
            return res.status(400).json({ error: 'validation_error', message: 'Maximum 20 tags allowed' });
        }

        // Generate unique slug
        let slug = generateSlug(title);
        const existingListing = getListingBySlug(slug);
        if (existingListing) {
            slug = `${slug}-${generateId().slice(-6).toLowerCase()}`;
        }

        const listing = createListing({
            seller_id: seller.id,
            org_id: orgId,
            title,
            slug,
            description: description || null,
            product_type: product_type || 'plugin',
            price_cents: price_cents || 0,
            price_model: price_model || 'free',
            category: category || null,
            tags_json: tags ? JSON.stringify(tags) : '[]',
            created_by: req.user.id
        });

        logOrgEvent('marketplace.listing_create', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: listing.id, slug, product_type: product_type || 'plugin'
        });

        res.status(201).json({ success: true, listing });
    } catch (err) {
        console.error('Create listing error:', err);
        res.status(500).json({ error: 'create_failed', message: 'Failed to create listing' });
    }
});

/**
 * GET /orgs/:orgId/listings — list org's listings
 */
router.get('/orgs/:orgId/listings', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, product_type, limit, offset } = req.query;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        const result = getListingsByOrg(orgId, {
            status, product_type,
            limit: Math.min(parseInt(limit) || 50, 100),
            offset: parseInt(offset) || 0
        });

        res.json({ listings: result.items, total: result.total });
    } catch (err) {
        console.error('List listings error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch listings' });
    }
});

/**
 * GET /orgs/:orgId/listings/:id — listing detail
 */
router.get('/orgs/:orgId/listings/:id', authenticate(), async (req, res) => {
    try {
        const { orgId, id } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        const versions = getVersionsByListing(id);
        const screenshots = getScreenshotsByListing(id);

        res.json({ listing, versions, screenshots });
    } catch (err) {
        console.error('Get listing error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch listing' });
    }
});

/**
 * PATCH /orgs/:orgId/listings/:id — update listing
 */
router.patch('/orgs/:orgId/listings/:id', authenticate(), async (req, res) => {
    try {
        const { orgId, id } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.BUILDER)) {
            return res.status(403).json({ error: 'forbidden', message: 'Builder role required' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        // Handle status change separately via updateListingStatus (validates transitions)
        if (req.body.status) {
            try {
                updateListingStatus(id, req.body.status);
            } catch (err) {
                return res.status(400).json({ error: 'validation_error', message: err.message });
            }
        }

        // If slug is being changed, validate format and check uniqueness
        if (req.body.slug && req.body.slug !== listing.slug) {
            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(req.body.slug) || req.body.slug.length > 50) {
                return res.status(400).json({ error: 'validation_error', message: 'Slug must be lowercase alphanumeric + hyphens, 2-50 chars' });
            }
            const slugTaken = getListingBySlug(req.body.slug);
            if (slugTaken) {
                return res.status(409).json({ error: 'slug_taken', message: 'Slug already in use' });
            }
        }

        // Strip status from body — already handled above
        const { status: _status, ...updateFields } = req.body;
        const updated = updateListing(id, updateFields);

        logOrgEvent('marketplace.listing_update', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: id, fields: Object.keys(req.body)
        });

        res.json({ success: true, listing: updated });
    } catch (err) {
        console.error('Update listing error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update listing' });
    }
});

/**
 * DELETE /orgs/:orgId/listings/:id — soft delete listing
 */
router.delete('/orgs/:orgId/listings/:id', authenticate(), async (req, res) => {
    try {
        const { orgId, id } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        softDeleteListing(id);

        logOrgEvent('marketplace.listing_delete', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: id, title: listing.title
        });

        res.json({ success: true, message: 'Listing deleted' });
    } catch (err) {
        console.error('Delete listing error:', err);
        res.status(500).json({ error: 'delete_failed', message: 'Failed to delete listing' });
    }
});

/**
 * POST /orgs/:orgId/listings/:id/versions — upload version + run Gate 1
 */
router.post('/orgs/:orgId/listings/:id/versions', authenticate(), pluginUpload.single('package'), async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const { version, changelog } = req.body;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.BUILDER)) {
            return res.status(403).json({ error: 'forbidden', message: 'Builder role required' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'no_file', message: 'Package file required' });
        }

        if (!version || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
            return res.status(400).json({ error: 'validation_error', message: 'Version must be valid semver (x.y.z)' });
        }

        // Check for duplicate version
        const existingVersions = getVersionsByListing(id);
        if (existingVersions.some(v => v.version === version)) {
            return res.status(409).json({ error: 'version_exists', message: `Version ${version} already exists` });
        }

        // Run automated review gate
        const gateResult = runReviewGate(req.file.buffer);

        // Save package to filesystem
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        const packageDir = join(MARKETPLACE_DIR, listing.slug);
        if (!existsSync(packageDir)) {
            mkdirSync(packageDir, { recursive: true });
        }
        const filename = `${listing.slug}-${version}.quoxplugin`;
        const packagePath = join(packageDir, filename);
        writeFileSync(packagePath, req.file.buffer);

        // Create version record
        const reviewStatus = gateResult.passed ? 'automated_passed' : 'automated_failed';
        const listingVersion = createListingVersion({
            listing_id: id,
            version,
            changelog: changelog || null,
            package_path: packagePath,
            package_hash: hash,
            package_size_bytes: req.file.buffer.length,
            automated_checks_json: JSON.stringify(gateResult),
            created_by: req.user.id
        });

        // If gate passed, mark listing as submitted for review
        if (gateResult.passed && listing.status === 'draft') {
            try { updateListingStatus(id, 'submitted'); } catch (e) { /* transition not allowed, ignore */ }
        }

        logOrgEvent('marketplace.version_upload', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: id, version, gate_passed: gateResult.passed, hash
        });

        res.status(201).json({
            success: true,
            version: listingVersion,
            gate: gateResult
        });
    } catch (err) {
        console.error('Upload version error:', err);
        res.status(500).json({ error: 'upload_failed', message: 'Failed to upload version' });
    }
});

/**
 * GET /orgs/:orgId/listings/:id/versions — list versions
 */
router.get('/orgs/:orgId/listings/:id/versions', authenticate(), async (req, res) => {
    try {
        const { orgId, id } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        const versions = getVersionsByListing(id);
        res.json({ versions });
    } catch (err) {
        console.error('List versions error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch versions' });
    }
});

/**
 * PATCH /orgs/:orgId/listings/:id/versions/:vid/yank — yank a version
 */
router.patch('/orgs/:orgId/listings/:id/versions/:vid/yank', authenticate(), async (req, res) => {
    try {
        const { orgId, id, vid } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.ADMIN)) {
            return res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
        }

        const listing = getListingById(id);
        if (!listing || listing.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        // Verify version belongs to this listing
        const versions = getVersionsByListing(id);
        const targetVersion = versions.find(v => v.id === vid);
        if (!targetVersion) {
            return res.status(404).json({ error: 'not_found', message: 'Version not found for this listing' });
        }

        const updated = updateVersionStatus(vid, { review_status: 'yanked' });

        logOrgEvent('marketplace.version_yank', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: id, version_id: vid
        });

        res.json({ success: true, version: updated });
    } catch (err) {
        console.error('Yank version error:', err);
        res.status(500).json({ error: 'yank_failed', message: 'Failed to yank version' });
    }
});

// ============================================================================
// Public marketplace routes (no auth)
// ============================================================================

/**
 * GET /marketplace/listings — browse published listings
 */
router.get('/marketplace/listings', async (req, res) => {
    try {
        const { product_type, category, search, seller_slug, limit, offset } = req.query;

        const result = getPublishedListings({
            product_type, category, search, seller_slug,
            limit: Math.min(parseInt(limit) || 20, 50),
            offset: parseInt(offset) || 0
        });

        res.json({ listings: result.items, total: result.total });
    } catch (err) {
        console.error('Browse listings error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch listings' });
    }
});

/**
 * GET /marketplace/listings/:slug — public listing detail
 */
router.get('/marketplace/listings/:slug', async (req, res) => {
    try {
        const listing = getListingBySlug(req.params.slug);
        if (!listing || listing.status !== 'published') {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        const screenshots = getScreenshotsByListing(listing.id);

        // Get latest approved version
        const versions = getVersionsByListing(listing.id);
        const latestApproved = versions.find(v => v.review_status === 'approved');

        res.json({
            listing: {
                id: listing.id,
                title: listing.title,
                slug: listing.slug,
                description: listing.description,
                product_type: listing.product_type,
                price_cents: listing.price_cents,
                price_model: listing.price_model,
                category: listing.category,
                tags_json: listing.tags_json,
                icon_path: listing.icon_path,
                published_at: listing.published_at,
                seller_name: listing.seller_name,
                seller_slug: listing.seller_slug
            },
            screenshots,
            latest_version: latestApproved ? {
                version: latestApproved.version,
                changelog: latestApproved.changelog,
                created_at: latestApproved.created_at
            } : null
        });
    } catch (err) {
        console.error('Public listing detail error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch listing' });
    }
});

export default router;
