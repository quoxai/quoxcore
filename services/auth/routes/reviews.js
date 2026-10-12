/**
 * Admin review routes for Marketplace (Stream 2: Developer Portal)
 *
 * GET    /admin/reviews                       — pending review queue (instance admin)
 * GET    /admin/reviews/:versionId            — review detail (instance admin)
 * POST   /admin/reviews/:versionId/approve    — approve (instance admin)
 * POST   /admin/reviews/:versionId/reject     — reject with reason (instance admin)
 * POST   /admin/reviews/:versionId/request-changes — request changes (instance admin)
 */

import { requireHumanDecider } from '../utils/principal.js';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/authorize.js';
import { logAudit } from '../utils/audit.js';
import {
    getPendingReviews, getReviewsByVersion, createSubmissionReview,
    updateVersionStatus, getVersionById, getListingById, updateListingStatus
} from '../db/marketplace.js';

const router = Router();

/**
 * GET /admin/reviews — pending review queue
 */
router.get('/admin/reviews', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit, offset } = req.query;

        const result = getPendingReviews({
            limit: Math.min(parseInt(limit) || 50, 100),
            offset: parseInt(offset) || 0
        });

        res.json({ reviews: result.items, total: result.total });
    } catch (err) {
        console.error('List reviews error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch reviews' });
    }
});

/**
 * GET /admin/reviews/:versionId — review detail
 */
router.get('/admin/reviews/:versionId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const version = getVersionById(req.params.versionId);
        if (!version) {
            return res.status(404).json({ error: 'not_found', message: 'Version not found' });
        }

        const listing = getListingById(version.listing_id);
        const reviews = getReviewsByVersion(req.params.versionId);

        let automatedChecks = {};
        try {
            automatedChecks = JSON.parse(version.automated_checks_json || '{}');
        } catch (e) { /* ignore */ }

        res.json({ version, listing, reviews, automated_checks: automatedChecks });
    } catch (err) {
        console.error('Review detail error:', err);
        res.status(500).json({ error: 'fetch_failed', message: 'Failed to fetch review detail' });
    }
});

/**
 * POST /admin/reviews/:versionId/approve — approve version
 */
router.post('/admin/reviews/:versionId/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const { versionId } = req.params;
        const { reason } = req.body;

        const version = getVersionById(versionId);
        if (!version) {
            return res.status(404).json({ error: 'not_found', message: 'Version not found' });
        }

        // Only allow approval from reviewable states
        if (!['pending', 'automated_passed', 'changes_requested'].includes(version.review_status)) {
            return res.status(400).json({
                error: 'invalid_state',
                message: `Cannot approve version in "${version.review_status}" state`
            });
        }

        // Update version status
        updateVersionStatus(versionId, {
            review_status: 'approved',
            reviewed_by: req.user.id,
            review_notes: reason || 'Approved'
        });

        // Create review record
        createSubmissionReview({
            version_id: versionId,
            reviewer_id: req.user.id,
            action: 'approve',
            reason: reason || null
        });

        // Publish the listing
        const listing = getListingById(version.listing_id);
        if (listing && listing.status !== 'published') {
            try { updateListingStatus(version.listing_id, 'published'); } catch (e) {
                // Status transition from current state not allowed — set to in_review first
                try {
                    updateListingStatus(version.listing_id, 'in_review');
                    updateListingStatus(version.listing_id, 'published');
                } catch (e2) { /* ignore — listing status unchanged */ }
            }
        }

        logAudit({
            action: 'marketplace.review_approve',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'listing_version', id: versionId },
            request: req,
            metadata: { listing_id: version.listing_id, version: version.version }
        });

        res.json({ success: true, message: 'Version approved and listing published' });
    } catch (err) {
        console.error('Approve review error:', err);
        res.status(500).json({ error: 'approve_failed', message: 'Failed to approve version' });
    }
});

/**
 * POST /admin/reviews/:versionId/reject — reject version
 */
router.post('/admin/reviews/:versionId/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const { versionId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ error: 'validation_error', message: 'Rejection reason is required' });
        }

        const version = getVersionById(versionId);
        if (!version) {
            return res.status(404).json({ error: 'not_found', message: 'Version not found' });
        }

        updateVersionStatus(versionId, {
            review_status: 'rejected',
            reviewed_by: req.user.id,
            review_notes: reason
        });

        createSubmissionReview({
            version_id: versionId,
            reviewer_id: req.user.id,
            action: 'reject',
            reason
        });

        logAudit({
            action: 'marketplace.review_reject',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'listing_version', id: versionId },
            request: req,
            metadata: { listing_id: version.listing_id, version: version.version, reason }
        });

        res.json({ success: true, message: 'Version rejected' });
    } catch (err) {
        console.error('Reject review error:', err);
        res.status(500).json({ error: 'reject_failed', message: 'Failed to reject version' });
    }
});

/**
 * POST /admin/reviews/:versionId/request-changes — request changes
 */
router.post('/admin/reviews/:versionId/request-changes', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { versionId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ error: 'validation_error', message: 'Change request details are required' });
        }

        const version = getVersionById(versionId);
        if (!version) {
            return res.status(404).json({ error: 'not_found', message: 'Version not found' });
        }

        updateVersionStatus(versionId, {
            review_status: 'changes_requested',
            reviewed_by: req.user.id,
            review_notes: reason
        });

        createSubmissionReview({
            version_id: versionId,
            reviewer_id: req.user.id,
            action: 'request_changes',
            reason
        });

        logAudit({
            action: 'marketplace.review_request_changes',
            actor: { type: 'user', id: req.user.id },
            target: { type: 'listing_version', id: versionId },
            request: req,
            metadata: { listing_id: version.listing_id, version: version.version, reason }
        });

        res.json({ success: true, message: 'Changes requested' });
    } catch (err) {
        console.error('Request changes error:', err);
        res.status(500).json({ error: 'request_changes_failed', message: 'Failed to request changes' });
    }
});

export default router;
