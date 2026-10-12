/**
 * Marketplace query module
 *
 * Handles sellers, listings, versions, screenshots, and reviews.
 * Follows the pattern from db/integrations.js.
 */

import { getDb, prepare, transaction } from './index.js';
import { generateId } from '../utils/crypto.js';

// ============================================================================
// Sellers
// ============================================================================

export function createSeller(data) {
    const {
        org_id, display_name, slug, github_username = null,
        bio = null, website = null, logo_path = null, created_by
    } = data;

    const id = generateId();

    prepare(`
        INSERT INTO sellers (id, org_id, display_name, slug, github_username, bio, website, logo_path, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, org_id, display_name, slug, github_username, bio, website, logo_path, created_by);

    return getSellerById(id);
}

export function getSellerById(id) {
    return prepare('SELECT * FROM sellers WHERE id = ? AND deleted_at IS NULL').get(id);
}

export function getSellerByOrgId(orgId) {
    return prepare('SELECT * FROM sellers WHERE org_id = ? AND deleted_at IS NULL').get(orgId);
}

export function getSellerBySlug(slug) {
    return prepare('SELECT * FROM sellers WHERE slug = ? AND deleted_at IS NULL').get(slug);
}

const ALLOWED_SELLER_COLUMNS = new Set([
    'display_name', 'slug', 'github_username', 'bio', 'website', 'logo_path'
]);

// trust_level is intentionally excluded — only settable by instance admins
const ALLOWED_SELLER_ADMIN_COLUMNS = new Set([
    'display_name', 'slug', 'github_username', 'bio', 'website', 'logo_path', 'trust_level'
]);

export function updateSeller(id, fields) {
    const updates = [];
    const values = [];

    for (const [key, value] of Object.entries(fields)) {
        if (ALLOWED_SELLER_COLUMNS.has(key)) {
            updates.push(`${key} = ?`);
            values.push(value);
        }
    }

    if (updates.length === 0) return getSellerById(id);

    updates.push("updated_at = datetime('now')");
    values.push(id);

    prepare(`UPDATE sellers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getSellerById(id);
}

export function updateSellerAsAdmin(id, fields) {
    const updates = [];
    const values = [];

    for (const [key, value] of Object.entries(fields)) {
        if (ALLOWED_SELLER_ADMIN_COLUMNS.has(key)) {
            updates.push(`${key} = ?`);
            values.push(value);
        }
    }

    if (updates.length === 0) return getSellerById(id);

    updates.push("updated_at = datetime('now')");
    values.push(id);

    prepare(`UPDATE sellers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getSellerById(id);
}

// ============================================================================
// Listings
// ============================================================================

export function createListing(data) {
    const {
        seller_id, org_id, title, slug, description = null,
        product_type = 'plugin', price_cents = 0, price_model = 'free',
        commission_rate = 0.20, category = null, tags_json = '[]',
        icon_path = null, created_by
    } = data;

    const id = generateId();

    prepare(`
        INSERT INTO listings (
            id, seller_id, org_id, title, slug, description, product_type,
            price_cents, price_model, commission_rate, category, tags_json,
            icon_path, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, seller_id, org_id, title, slug, description, product_type,
        price_cents, price_model, commission_rate, category, tags_json,
        icon_path, created_by
    );

    return getListingById(id);
}

export function getListingById(id) {
    return prepare(`
        SELECT l.*, s.display_name as seller_name, s.slug as seller_slug
        FROM listings l
        JOIN sellers s ON l.seller_id = s.id
        WHERE l.id = ? AND l.deleted_at IS NULL
    `).get(id);
}

export function getListingBySlug(slug) {
    return prepare(`
        SELECT l.*, s.display_name as seller_name, s.slug as seller_slug
        FROM listings l
        JOIN sellers s ON l.seller_id = s.id
        WHERE l.slug = ? AND l.deleted_at IS NULL
    `).get(slug);
}

export function getListingsByOrg(orgId, filters = {}) {
    const { status, product_type, limit = 50, offset = 0 } = filters;

    const conditions = ['l.org_id = ?', 'l.deleted_at IS NULL'];
    const params = [orgId];

    if (status) {
        conditions.push('l.status = ?');
        params.push(status);
    }
    if (product_type) {
        conditions.push('l.product_type = ?');
        params.push(product_type);
    }

    const where = conditions.join(' AND ');

    const items = getDb().prepare(`
        SELECT l.*, s.display_name as seller_name, s.slug as seller_slug
        FROM listings l
        JOIN sellers s ON l.seller_id = s.id
        WHERE ${where}
        ORDER BY l.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = getDb().prepare(
        `SELECT COUNT(*) as count FROM listings l WHERE ${where}`
    ).get(...params);

    return { items, total: total?.count || 0 };
}

export function getPublishedListings(filters = {}) {
    const { product_type, category, search, seller_slug, limit = 20, offset = 0 } = filters;

    const conditions = ["l.status = 'published'", 'l.deleted_at IS NULL'];
    const params = [];

    if (product_type) {
        conditions.push('l.product_type = ?');
        params.push(product_type);
    }
    if (category) {
        conditions.push('l.category = ?');
        params.push(category);
    }
    if (search) {
        conditions.push('(l.title LIKE ? OR l.description LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (seller_slug) {
        conditions.push('s.slug = ?');
        params.push(seller_slug);
    }

    const where = conditions.join(' AND ');

    const items = getDb().prepare(`
        SELECT l.id, l.title, l.slug, l.description, l.product_type, l.price_cents,
               l.price_model, l.category, l.tags_json, l.icon_path, l.published_at,
               s.display_name as seller_name, s.slug as seller_slug, s.trust_level
        FROM listings l
        JOIN sellers s ON l.seller_id = s.id
        WHERE ${where}
        ORDER BY l.published_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = getDb().prepare(
        `SELECT COUNT(*) as count FROM listings l JOIN sellers s ON l.seller_id = s.id WHERE ${where}`
    ).get(...params);

    return { items, total: total?.count || 0 };
}

// status intentionally excluded — use updateListingStatus() for state transitions
const ALLOWED_LISTING_COLUMNS = new Set([
    'title', 'slug', 'description', 'product_type',
    'price_cents', 'price_model', 'category', 'tags_json', 'icon_path'
]);

export function updateListing(id, fields) {
    const updates = [];
    const values = [];

    for (const [key, value] of Object.entries(fields)) {
        if (ALLOWED_LISTING_COLUMNS.has(key)) {
            updates.push(`${key} = ?`);
            values.push(value);
        }
    }

    // If status changing to published, set published_at
    if (fields.status === 'published') {
        updates.push("published_at = datetime('now')");
    }

    if (updates.length === 0) return getListingById(id);

    updates.push("updated_at = datetime('now')");
    values.push(id);

    prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getListingById(id);
}

const VALID_STATUS_TRANSITIONS = {
    draft: ['submitted'],
    submitted: ['in_review', 'draft'],
    in_review: ['published', 'rejected', 'draft'],
    published: ['suspended', 'delisted'],
    suspended: ['published', 'delisted'],
    delisted: ['draft'],
};

export function updateListingStatus(id, newStatus) {
    const listing = getListingById(id);
    if (!listing) return null;

    const allowed = VALID_STATUS_TRANSITIONS[listing.status];
    if (!allowed || !allowed.includes(newStatus)) {
        throw new Error(`Invalid status transition: ${listing.status} → ${newStatus}`);
    }

    const updates = ['status = ?', "updated_at = datetime('now')"];
    const values = [newStatus];

    if (newStatus === 'published') {
        updates.push("published_at = datetime('now')");
    }

    values.push(id);
    prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getListingById(id);
}

export function softDeleteListing(id) {
    prepare(`
        UPDATE listings SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
    `).run(id);
}

// ============================================================================
// Listing Versions
// ============================================================================

export function createListingVersion(data) {
    const {
        listing_id, version, changelog = null,
        package_path = null, package_hash = null, package_size_bytes = null,
        automated_checks_json = '{}', created_by
    } = data;

    const id = generateId();

    prepare(`
        INSERT INTO listing_versions (
            id, listing_id, version, changelog, package_path, package_hash,
            package_size_bytes, automated_checks_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, listing_id, version, changelog, package_path, package_hash,
        package_size_bytes, automated_checks_json, created_by);

    return getVersionById(id);
}

export function getVersionById(id) {
    return prepare('SELECT * FROM listing_versions WHERE id = ?').get(id);
}

export function getVersionsByListing(listingId) {
    return prepare(`
        SELECT * FROM listing_versions
        WHERE listing_id = ?
        ORDER BY created_at DESC
    `).all(listingId);
}

export function updateVersionStatus(id, fields) {
    const { review_status, reviewed_by, review_notes, automated_checks_json } = fields;
    const updates = [];
    const values = [];

    if (review_status) {
        updates.push('review_status = ?');
        values.push(review_status);
    }
    if (reviewed_by) {
        updates.push('reviewed_by = ?');
        values.push(reviewed_by);
        updates.push("reviewed_at = datetime('now')");
    }
    if (review_notes !== undefined) {
        updates.push('review_notes = ?');
        values.push(review_notes);
    }
    if (automated_checks_json) {
        updates.push('automated_checks_json = ?');
        values.push(automated_checks_json);
    }

    if (updates.length === 0) return getVersionById(id);

    values.push(id);
    prepare(`UPDATE listing_versions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return getVersionById(id);
}

// ============================================================================
// Screenshots
// ============================================================================

export function createScreenshot(data) {
    const { listing_id, file_path, caption = null, sort_order = 0 } = data;
    const id = generateId();

    prepare(`
        INSERT INTO listing_screenshots (id, listing_id, file_path, caption, sort_order)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, listing_id, file_path, caption, sort_order);

    return prepare('SELECT * FROM listing_screenshots WHERE id = ?').get(id);
}

export function getScreenshotsByListing(listingId) {
    return prepare(`
        SELECT * FROM listing_screenshots
        WHERE listing_id = ?
        ORDER BY sort_order ASC
    `).all(listingId);
}

export function deleteScreenshot(id) {
    return prepare('DELETE FROM listing_screenshots WHERE id = ?').run(id);
}

// ============================================================================
// Submission Reviews
// ============================================================================

export function createSubmissionReview(data) {
    const { version_id, reviewer_id, action, reason = null } = data;
    const id = generateId();

    prepare(`
        INSERT INTO submission_reviews (id, version_id, reviewer_id, action, reason)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, version_id, reviewer_id, action, reason);

    return prepare('SELECT * FROM submission_reviews WHERE id = ?').get(id);
}

export function getReviewsByVersion(versionId) {
    return prepare(`
        SELECT sr.*, u.display_name as reviewer_name
        FROM submission_reviews sr
        LEFT JOIN users u ON sr.reviewer_id = u.id
        WHERE sr.version_id = ?
        ORDER BY sr.created_at DESC
    `).all(versionId);
}

export function getPendingReviews(filters = {}) {
    const { limit = 50, offset = 0 } = filters;

    const items = getDb().prepare(`
        SELECT lv.*, l.title as listing_title, l.slug as listing_slug,
               l.product_type, s.display_name as seller_name, s.slug as seller_slug,
               s.trust_level
        FROM listing_versions lv
        JOIN listings l ON lv.listing_id = l.id
        JOIN sellers s ON l.seller_id = s.id
        WHERE lv.review_status IN ('pending', 'automated_passed')
        AND l.deleted_at IS NULL
        ORDER BY lv.created_at ASC
        LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = getDb().prepare(`
        SELECT COUNT(*) as count
        FROM listing_versions lv
        JOIN listings l ON lv.listing_id = l.id
        WHERE lv.review_status IN ('pending', 'automated_passed')
        AND l.deleted_at IS NULL
    `).get();

    return { items, total: total?.count || 0 };
}

// ============================================================================
// Installs (Stream 3)
// ============================================================================

export function createInstall(data) {
    const { listing_id, listing_version_id, org_id, installed_by } = data;
    const id = generateId();

    prepare(`
        INSERT INTO marketplace_installs (id, listing_id, listing_version_id, org_id, installed_by)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, listing_id, listing_version_id, org_id, installed_by);

    refreshListingStats(listing_id);

    return prepare('SELECT * FROM marketplace_installs WHERE id = ?').get(id);
}

export function getInstallByOrgAndListing(orgId, listingId) {
    return prepare(`
        SELECT * FROM marketplace_installs
        WHERE org_id = ? AND listing_id = ? AND status = 'active'
    `).get(orgId, listingId);
}

export function getInstallsByOrg(orgId) {
    return prepare(`
        SELECT mi.*, l.title, l.slug, l.product_type, l.icon_path,
               lv.version, s.display_name as seller_name, s.slug as seller_slug
        FROM marketplace_installs mi
        JOIN listings l ON mi.listing_id = l.id
        JOIN listing_versions lv ON mi.listing_version_id = lv.id
        JOIN sellers s ON l.seller_id = s.id
        WHERE mi.org_id = ? AND mi.status = 'active'
        ORDER BY mi.installed_at DESC
    `).all(orgId);
}

export function uninstall(orgId, listingId) {
    prepare(`
        UPDATE marketplace_installs
        SET status = 'uninstalled', uninstalled_at = datetime('now')
        WHERE org_id = ? AND listing_id = ? AND status = 'active'
    `).run(orgId, listingId);

    refreshListingStats(listingId);
}

// ============================================================================
// User Reviews (Stream 3)
// ============================================================================

export function createReview(data) {
    const { listing_id, user_id, org_id, rating, title = null, body = null } = data;
    const id = generateId();

    prepare(`
        INSERT INTO marketplace_reviews (id, listing_id, user_id, org_id, rating, title, body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, listing_id, user_id, org_id, rating, title, body);

    refreshListingStats(listing_id);

    return prepare('SELECT * FROM marketplace_reviews WHERE id = ?').get(id);
}

export function getReviewsByListing(listingId, filters = {}) {
    const { limit = 20, offset = 0 } = filters;

    const items = getDb().prepare(`
        SELECT mr.*, u.display_name as reviewer_name
        FROM marketplace_reviews mr
        LEFT JOIN users u ON mr.user_id = u.id
        WHERE mr.listing_id = ? AND mr.status = 'published'
        ORDER BY mr.created_at DESC
        LIMIT ? OFFSET ?
    `).all(listingId, limit, offset);

    const total = getDb().prepare(
        `SELECT COUNT(*) as count FROM marketplace_reviews WHERE listing_id = ? AND status = 'published'`
    ).get(listingId);

    return { items, total: total?.count || 0 };
}

export function getReviewById(id) {
    return prepare('SELECT * FROM marketplace_reviews WHERE id = ?').get(id);
}

export function getUserReview(listingId, userId) {
    return prepare(
        `SELECT * FROM marketplace_reviews WHERE listing_id = ? AND user_id = ?`
    ).get(listingId, userId);
}

export function updateReview(id, fields) {
    const updates = [];
    const values = [];

    if (fields.rating !== undefined) { updates.push('rating = ?'); values.push(fields.rating); }
    if (fields.title !== undefined) { updates.push('title = ?'); values.push(fields.title); }
    if (fields.body !== undefined) { updates.push('body = ?'); values.push(fields.body); }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");
    values.push(id);

    prepare(`UPDATE marketplace_reviews SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const review = prepare('SELECT * FROM marketplace_reviews WHERE id = ?').get(id);
    if (review) refreshListingStats(review.listing_id);
    return review;
}

export function deleteReview(id) {
    const review = prepare('SELECT listing_id FROM marketplace_reviews WHERE id = ?').get(id);
    prepare('DELETE FROM marketplace_reviews WHERE id = ?').run(id);
    if (review) refreshListingStats(review.listing_id);
}

// ============================================================================
// Listing Stats (denormalized counters)
// ============================================================================

export function getListingStats(listingId) {
    return prepare('SELECT * FROM listing_stats WHERE listing_id = ?').get(listingId);
}

export function refreshListingStats(listingId) {
    const installs = getDb().prepare(
        `SELECT COUNT(*) as count FROM marketplace_installs WHERE listing_id = ? AND status = 'active'`
    ).get(listingId);

    const reviews = getDb().prepare(
        `SELECT COUNT(*) as count, COALESCE(AVG(rating), 0) as avg_rating
         FROM marketplace_reviews WHERE listing_id = ? AND status = 'published'`
    ).get(listingId);

    getDb().prepare(`
        INSERT INTO listing_stats (listing_id, install_count, review_count, average_rating, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(listing_id) DO UPDATE SET
            install_count = excluded.install_count,
            review_count = excluded.review_count,
            average_rating = excluded.average_rating,
            updated_at = datetime('now')
    `).run(listingId, installs?.count || 0, reviews?.count || 0, reviews?.avg_rating || 0);
}
