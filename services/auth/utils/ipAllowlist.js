/**
 * ET-4 Phase C — IP allowlist (pure helpers + CRUD).
 *
 * IPv4-only for now. Empty / null / undefined rule set = allow-all
 * (feature is opt-in). Invalid rules are skipped, not fatal — a single
 * bad entry must not lock the whole org out.
 */

import { ulid } from './helpers.js';

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────

// Strip the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) so dual-stack proxies
// that hand us mapped addresses behave like they handed us the v4 address.
export function normaliseIp(ip) {
    if (typeof ip !== 'string') return ip;
    const match = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    return match ? match[1] : ip;
}

export function isIpv6(ip) {
    if (typeof ip !== 'string') return false;
    // Anything with a colon that isn't IPv4-mapped is treated as v6.
    if (!ip.includes(':')) return false;
    return !/^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(ip);
}

function ipToInt(ip) {
    if (typeof ip !== 'string') throw new Error('ip must be a string');
    const parts = ip.split('.');
    if (parts.length !== 4) throw new Error(`invalid ip: ${ip}`);
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) throw new Error(`invalid ip octet: ${p}`);
        const o = Number(p);
        if (o < 0 || o > 255) throw new Error(`ip octet out of range: ${p}`);
        n = (n * 256) + o;
    }
    return n >>> 0;
}

export function parseCidr(input) {
    if (typeof input !== 'string' || !input.length) {
        throw new Error('cidr: expected non-empty string');
    }
    const [ipPart, prefixPart] = input.split('/');
    const prefixLen = prefixPart === undefined ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
        throw new Error(`cidr: invalid prefix length "${prefixPart}"`);
    }
    const ipInt = ipToInt(ipPart);
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    const base = (ipInt & mask) >>> 0;
    return { base, mask, prefixLen };
}

export function isIpInCidr(ip, cidr) {
    try {
        const { base, mask } = parseCidr(cidr);
        const n = ipToInt(ip);
        return ((n & mask) >>> 0) === base;
    } catch {
        return false;
    }
}

export function isIpAllowed(ip, rules) {
    if (!rules || !Array.isArray(rules) || rules.length === 0) return true;
    for (const rule of rules) {
        if (isIpInCidr(ip, rule)) return true;
    }
    return false;
}

// ──────────────────────────────────────────────────────────────────────
// Schema + CRUD
// ──────────────────────────────────────────────────────────────────────

export function ensureIpAllowlistSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ip_allowlist (
            id         TEXT PRIMARY KEY,
            org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            cidr       TEXT NOT NULL,
            label      TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            created_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ip_allowlist_org ON ip_allowlist(org_id);
    `);
}

export function listIpAllowlist(db, orgId) {
    return db.prepare(`
        SELECT id, org_id, cidr, label, created_at, created_by
        FROM ip_allowlist
        WHERE org_id = ?
        ORDER BY created_at ASC, id ASC
    `).all(orgId);
}

export function addIpAllowlistEntry(db, orgId, { cidr, label = null, createdBy = null }) {
    // Validate CIDR up front — throws with "cidr" in message for route mapping.
    try {
        parseCidr(cidr);
    } catch (err) {
        throw new Error(`invalid cidr: ${err.message}`);
    }
    const id = ulid();
    db.prepare(`
        INSERT INTO ip_allowlist (id, org_id, cidr, label, created_by)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, orgId, cidr, label, createdBy);
    return db.prepare(`
        SELECT id, org_id, cidr, label, created_at, created_by
        FROM ip_allowlist WHERE id = ?
    `).get(id);
}

export function removeIpAllowlistEntry(db, orgId, entryId) {
    db.prepare(`DELETE FROM ip_allowlist WHERE id = ? AND org_id = ?`).run(entryId, orgId);
}
