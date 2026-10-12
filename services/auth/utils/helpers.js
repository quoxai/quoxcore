/**
 * Helper utilities for Quox Auth Service
 */

import crypto from 'crypto';
import { prepare } from '../db/index.js';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Uses cryptographically secure random source for the random portion.
 * @returns {string} 26-character ULID
 */
export function ulid() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
    // Use cryptographically secure random bytes
    const randomBytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) {
        rand += chars[randomBytes[i] % 32];
    }
    return time + rand;
}

/**
 * Create an audit event
 * @param {Object} event - Event details
 * @param {string} [event.orgId] - Organization ID (optional for global events)
 * @param {string} event.actorType - 'user', 'service_account', or 'system'
 * @param {string} event.actorId - Actor's ID
 * @param {string} event.action - Action identifier (e.g., 'team.create')
 * @param {string} [event.targetType] - Target entity type
 * @param {string} [event.targetId] - Target entity ID
 * @param {string} [event.scopeId] - Scope ID if applicable
 * @param {string} [event.status='success'] - 'success', 'failure', or 'denied'
 * @param {string} [event.ipAddress] - Client IP
 * @param {string} [event.userAgent] - Client user agent
 * @param {Object} [event.metadata={}] - Additional metadata
 */
export function createAuditEvent(event) {
    const id = ulid();

    try {
        prepare(`
            INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, scope_id, status, ip_address, user_agent, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            event.orgId || null,
            event.actorType,
            event.actorId,
            event.action,
            event.targetType || null,
            event.targetId || null,
            event.scopeId || null,
            event.status || 'success',
            event.ipAddress || null,
            event.userAgent || null,
            JSON.stringify(event.metadata || {})
        );
    } catch (error) {
        console.error('Failed to create audit event:', error);
        // Don't throw - audit logging should not break main operations
    }

    return id;
}

/**
 * Generate a URL-safe slug from a string
 * @param {string} text - Input text
 * @returns {string} Lowercase slug with hyphens
 */
export function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')        // Replace spaces with -
        .replace(/[^\w\-]+/g, '')    // Remove non-word chars
        .replace(/\-\-+/g, '-')      // Replace multiple - with single -
        .replace(/^-+/, '')          // Trim - from start
        .replace(/-+$/, '');         // Trim - from end
}

/**
 * Parse JSON safely with a default value
 * @param {string} jsonString - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed value or default
 */
export function safeJsonParse(jsonString, defaultValue = {}) {
    if (!jsonString) return defaultValue;
    try {
        return JSON.parse(jsonString);
    } catch {
        return defaultValue;
    }
}

/**
 * Get pagination parameters from request query
 * @param {Object} query - Request query object
 * @param {number} [defaultLimit=20] - Default limit
 * @param {number} [maxLimit=100] - Maximum allowed limit
 * @returns {{ limit: number, offset: number, page: number }}
 */
export function getPagination(query, defaultLimit = 20, maxLimit = 100) {
    const page = Math.max(1, parseInt(query.page) || 1);
    let limit = parseInt(query.limit) || defaultLimit;
    limit = Math.min(Math.max(1, limit), maxLimit);
    const offset = (page - 1) * limit;

    return { limit, offset, page };
}

/**
 * Format pagination response
 * @param {Array} items - Items for current page
 * @param {number} total - Total count
 * @param {{ limit: number, offset: number, page: number }} pagination
 * @returns {Object} Formatted response with pagination metadata
 */
export function formatPaginatedResponse(items, total, pagination) {
    const totalPages = Math.ceil(total / pagination.limit);

    return {
        items,
        pagination: {
            page: pagination.page,
            limit: pagination.limit,
            total,
            total_pages: totalPages,
            has_more: pagination.page < totalPages
        }
    };
}

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean}
 */
export function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Generate a secure random token
 * @param {number} [length=32] - Token length in bytes
 * @returns {string} Hex-encoded token
 */
export function generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash a value using SHA-256
 * @param {string} value - Value to hash
 * @returns {string} Hex-encoded hash
 */
export function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export default {
    ulid,
    createAuditEvent,
    slugify,
    safeJsonParse,
    getPagination,
    formatPaginatedResponse,
    isValidEmail,
    generateToken,
    sha256
};
