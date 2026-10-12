/**
 * Marketplace routes — Stream 3 (Install, Reviews, Download)
 *
 * POST   /orgs/:orgId/marketplace/install/:listingId    — install free plugin (BUILDER+)
 * DELETE /orgs/:orgId/marketplace/install/:listingId    — uninstall (BUILDER+)
 * GET    /orgs/:orgId/marketplace/installed              — list installed (VIEWER+)
 * POST   /orgs/:orgId/marketplace/reviews/:listingId    — leave review (VIEWER+)
 * PATCH  /orgs/:orgId/marketplace/reviews/:reviewId     — edit own review
 * DELETE /orgs/:orgId/marketplace/reviews/:reviewId     — delete own review
 * GET    /marketplace/listings/:listingId/reviews        — public reviews (no auth)
 * GET    /marketplace/listings/:listingId/stats          — public stats (no auth)
 * GET    /marketplace/listings/:listingId/download       — download package (no auth, free only)
 */

import { Router } from 'express';
import { existsSync, createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename, resolve } from 'path';
import { authenticate } from '../middleware/authenticate.js';
import { queries } from '../db/index.js';
import { hasRoleLevel, OrgRoles } from '../utils/policy.js';
import { logOrgEvent } from '../utils/audit.js';
import {
    getListingById, getListingBySlug, getVersionsByListing,
    createInstall, getInstallByOrgAndListing, getInstallsByOrg, uninstall,
    createReview, getReviewsByListing, getUserReview, getReviewById, updateReview, deleteReview,
    getListingStats
} from '../db/marketplace.js';

const router = Router();

// ============================================================================
// Install / Uninstall (org-scoped, authenticated)
// ============================================================================

/**
 * POST /orgs/:orgId/marketplace/install/:listingId — install a free plugin
 */
router.post('/orgs/:orgId/marketplace/install/:listingId', authenticate(), async (req, res) => {
    try {
        const { orgId, listingId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.BUILDER)) {
            return res.status(403).json({ error: 'forbidden', message: 'Builder role required' });
        }

        const listing = getListingById(listingId);
        if (!listing || listing.status !== 'published') {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found or not published' });
        }

        // Only free plugins for now (paid requires Stream 4 / Stripe)
        if (listing.price_model !== 'free') {
            return res.status(400).json({ error: 'payment_required', message: 'Paid plugins are not yet supported. Coming soon.' });
        }

        // Check if already installed
        const existing = getInstallByOrgAndListing(orgId, listingId);
        if (existing) {
            return res.status(409).json({ error: 'already_installed', message: 'Plugin is already installed' });
        }

        // Get latest approved version
        const versions = getVersionsByListing(listingId);
        const approved = versions.find(v => v.review_status === 'approved');
        if (!approved) {
            return res.status(400).json({ error: 'no_version', message: 'No approved version available' });
        }

        const install = createInstall({
            listing_id: listingId,
            listing_version_id: approved.id,
            org_id: orgId,
            installed_by: req.user.id
        });

        logOrgEvent('marketplace.install', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: listingId, version: approved.version
        });

        res.status(201).json({ success: true, install });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'already_installed', message: 'Plugin is already installed' });
        }
        console.error('Install error:', err);
        res.status(500).json({ error: 'install_failed', message: 'Failed to install plugin' });
    }
});

/**
 * DELETE /orgs/:orgId/marketplace/install/:listingId — uninstall
 */
router.delete('/orgs/:orgId/marketplace/install/:listingId', authenticate(), async (req, res) => {
    try {
        const { orgId, listingId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership || !hasRoleLevel(membership.role, OrgRoles.BUILDER)) {
            return res.status(403).json({ error: 'forbidden', message: 'Builder role required' });
        }

        const existing = getInstallByOrgAndListing(orgId, listingId);
        if (!existing) {
            return res.status(404).json({ error: 'not_installed', message: 'Plugin is not installed' });
        }

        uninstall(orgId, listingId);

        logOrgEvent('marketplace.uninstall', { type: 'user', id: req.user.id }, orgId, req, {
            listing_id: listingId
        });

        res.json({ success: true, message: 'Plugin uninstalled' });
    } catch (err) {
        console.error('Uninstall error:', err);
        res.status(500).json({ error: 'uninstall_failed', message: 'Failed to uninstall plugin' });
    }
});

/**
 * GET /orgs/:orgId/marketplace/installed — list installed plugins
 */
router.get('/orgs/:orgId/marketplace/installed', authenticate(), async (req, res) => {
    try {
        const { orgId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        const installs = getInstallsByOrg(orgId);
        res.json({ installs });
    } catch (err) {
        console.error('List installs error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch installed plugins' });
    }
});

// ============================================================================
// User Reviews (org-scoped, authenticated)
// ============================================================================

/**
 * POST /orgs/:orgId/marketplace/reviews/:listingId — leave a review
 */
router.post('/orgs/:orgId/marketplace/reviews/:listingId', authenticate(), async (req, res) => {
    try {
        const { orgId, listingId } = req.params;
        const { rating, title, body } = req.body;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
            return res.status(400).json({ error: 'validation_error', message: 'Rating must be an integer from 1 to 5' });
        }

        const listing = getListingById(listingId);
        if (!listing || listing.status !== 'published') {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        // Cannot review own listing
        if (listing.org_id === orgId) {
            return res.status(400).json({ error: 'self_review', message: 'Cannot review your own listing' });
        }

        // Check if already reviewed
        const existing = getUserReview(listingId, req.user.id);
        if (existing) {
            return res.status(409).json({ error: 'already_reviewed', message: 'You have already reviewed this listing' });
        }

        const review = createReview({
            listing_id: listingId,
            user_id: req.user.id,
            org_id: orgId,
            rating,
            title: title || null,
            body: body || null
        });

        res.status(201).json({ success: true, review });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'already_reviewed', message: 'You have already reviewed this listing' });
        }
        console.error('Create review error:', err);
        res.status(500).json({ error: 'review_failed', message: 'Failed to create review' });
    }
});

/**
 * PATCH /orgs/:orgId/marketplace/reviews/:reviewId — edit own review
 */
router.patch('/orgs/:orgId/marketplace/reviews/:reviewId', authenticate(), async (req, res) => {
    try {
        const { orgId, reviewId } = req.params;
        const { rating, title, body } = req.body;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        if (rating !== undefined && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
            return res.status(400).json({ error: 'validation_error', message: 'Rating must be an integer from 1 to 5' });
        }

        // Verify ownership — users can only edit their own reviews
        const existing = getReviewById(reviewId);
        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Review not found' });
        }
        if (existing.user_id !== req.user.id) {
            return res.status(403).json({ error: 'forbidden', message: 'You can only edit your own reviews' });
        }

        const review = updateReview(reviewId, { rating, title, body });

        res.json({ success: true, review });
    } catch (err) {
        console.error('Update review error:', err);
        res.status(500).json({ error: 'update_failed', message: 'Failed to update review' });
    }
});

/**
 * DELETE /orgs/:orgId/marketplace/reviews/:reviewId — delete own review
 */
router.delete('/orgs/:orgId/marketplace/reviews/:reviewId', authenticate(), async (req, res) => {
    try {
        const { orgId, reviewId } = req.params;

        const membership = queries.getOrgMembership(orgId, req.user.id);
        if (!membership) {
            return res.status(403).json({ error: 'forbidden', message: 'Not a member of this organisation' });
        }

        // Verify ownership
        const existing = getReviewById(reviewId);
        if (!existing) {
            return res.status(404).json({ error: 'not_found', message: 'Review not found' });
        }
        if (existing.user_id !== req.user.id) {
            return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own reviews' });
        }

        deleteReview(reviewId);
        res.json({ success: true, message: 'Review deleted' });
    } catch (err) {
        console.error('Delete review error:', err);
        res.status(500).json({ error: 'delete_failed', message: 'Failed to delete review' });
    }
});

// ============================================================================
// Public endpoints (no auth)
// ============================================================================

/**
 * GET /marketplace/listings/:listingId/reviews — public reviews
 */
router.get('/marketplace/listings/:listingId/reviews', async (req, res) => {
    try {
        const { limit, offset } = req.query;
        const result = getReviewsByListing(req.params.listingId, {
            limit: Math.min(parseInt(limit) || 20, 50),
            offset: parseInt(offset) || 0
        });
        res.json({ reviews: result.items, total: result.total });
    } catch (err) {
        console.error('Public reviews error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch reviews' });
    }
});

/**
 * GET /marketplace/listings/:listingId/stats — public stats
 */
router.get('/marketplace/listings/:listingId/stats', async (req, res) => {
    try {
        const stats = getListingStats(req.params.listingId) || {
            install_count: 0, review_count: 0, average_rating: 0
        };
        res.json({ stats });
    } catch (err) {
        console.error('Public stats error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch stats' });
    }
});

/**
 * GET /marketplace/listings/:listingId/download — download latest approved package (free only)
 */
router.get('/marketplace/listings/:listingId/download', async (req, res) => {
    try {
        const listing = getListingById(req.params.listingId);
        if (!listing || listing.status !== 'published') {
            return res.status(404).json({ error: 'not_found', message: 'Listing not found' });
        }

        if (listing.price_model !== 'free') {
            return res.status(402).json({ error: 'payment_required', message: 'This is a paid plugin. Purchase required.' });
        }

        const versions = getVersionsByListing(listing.id);
        const approved = versions.find(v => v.review_status === 'approved');
        if (!approved || !approved.package_path) {
            return res.status(404).json({ error: 'no_version', message: 'No downloadable version available' });
        }

        // Path containment check — prevent path traversal
        const UPLOAD_DIR = process.env.UPLOAD_DIR || '/var/lib/quox/uploads';
        const resolvedPath = resolve(approved.package_path);
        if (!resolvedPath.startsWith(resolve(UPLOAD_DIR))) {
            return res.status(403).json({ error: 'forbidden', message: 'Invalid package path' });
        }

        if (!existsSync(resolvedPath)) {
            return res.status(404).json({ error: 'file_missing', message: 'Package file not found' });
        }

        const fileStat = await stat(resolvedPath);
        const filename = `${listing.slug}-${approved.version}.quoxplugin`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', fileStat.size);
        if (approved.package_hash) {
            res.setHeader('X-Package-Hash', approved.package_hash);
        }
        // Stream instead of readFileSync to avoid blocking event loop
        createReadStream(resolvedPath).pipe(res);
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'download_failed', message: 'Failed to download package' });
    }
});

export default router;
