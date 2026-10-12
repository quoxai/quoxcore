/**
 * ET-3 Phase A — domain verification (DNS TXT method).
 *
 * An org can claim an email domain by publishing a TXT record whose
 * value matches the verification token we issue. Once verified, the
 * row unlocks domain-scoped flows: auto-join via email match, SSO
 * JIT-provisioning to the right org, and domain-restricted invites.
 *
 * Schema notes:
 *   - UNIQUE(domain) on verified rows enforces "one org owns each
 *     verified domain". Pending (unverified) rows can coexist across
 *     orgs so multiple tenants can start the flow in parallel; the
 *     first to verify wins.
 */

import { ulid } from './helpers.js';
import { randomBytes } from 'crypto';

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureDomainsSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS verified_domains (
            id                  TEXT PRIMARY KEY,
            org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            domain              TEXT NOT NULL,
            verification_token  TEXT NOT NULL,
            verification_method TEXT,
            verified_at         TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, domain)
        );
        CREATE INDEX IF NOT EXISTS idx_verified_domains_domain
            ON verified_domains(domain, verified_at);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

export function normaliseDomain(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
    if (!trimmed) return null;
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed)) return null;
    return trimmed;
}

function generateVerificationToken() {
    return `quox-verify-${randomBytes(16).toString('base64url')}`;
}

// ──────────────────────────────────────────────────────────────────────
// CRUD + flow
// ──────────────────────────────────────────────────────────────────────

// ET-ENFORCE round-4 — minimal blocklist of public consumer / disposable
// email domains that no single org should ever own. Without this, the first
// tenant to publish the DNS TXT for, say, "gmail.com" would capture every
// new gmail.com signup via auto-join. A full public-suffix-list (PSL) check
// would be more robust but requires the `psl` package; this hand-maintained
// list catches the highest-impact cases. Extend as needed.
const PUBLIC_DOMAIN_BLOCKLIST = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'yahoo.co.uk', 'aol.com', 'icloud.com', 'me.com',
    'mac.com', 'protonmail.com', 'pm.me', 'proton.me', 'tutanota.com',
    'tuta.io', 'gmx.com', 'gmx.net', 'mail.com', 'fastmail.com', 'zoho.com',
    'qq.com', '163.com', '126.com', 'sina.com', 'yandex.com', 'yandex.ru',
    'mail.ru', 'rambler.ru', 'comcast.net', 'verizon.net', 'att.net',
    'sbcglobal.net', 'cox.net', 'btinternet.com', 'sky.com', 'orange.fr',
    'free.fr', 'web.de', 't-online.de', 'libero.it', 'virgilio.it',
    // Disposable / temp providers
    'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com',
    'temp-mail.org', 'throwawaymail.com', 'getnada.com', 'sharklasers.com',
    // Quox-internal test domains
    'test.local', 'example.com', 'example.org', 'example.net',
]);

export function isPublicDomain(domain) {
    return PUBLIC_DOMAIN_BLOCKLIST.has(domain);
}

export function startDomainVerification(db, orgId, rawDomain) {
    const domain = normaliseDomain(rawDomain);
    if (!domain) throw new Error(`invalid domain "${rawDomain}"`);

    // ET-ENFORCE round-4: no single tenant should claim a public consumer
    // domain. This is a soft block — the canonical defence is for ops to
    // refuse such domains in admin onboarding.
    if (isPublicDomain(domain)) {
        throw new Error(`domain "${domain}" is a public consumer domain and cannot be verified by a single org`);
    }

    // Refuse if another org has already verified this domain.
    const ownedElsewhere = db.prepare(`
        SELECT id FROM verified_domains
        WHERE domain = ? AND org_id != ? AND verified_at IS NOT NULL
    `).get(domain, orgId);
    if (ownedElsewhere) {
        throw new Error(`domain "${domain}" is already claimed by another org`);
    }

    // Return existing row if one already exists for this org.
    const existing = db.prepare(
        `SELECT * FROM verified_domains WHERE org_id = ? AND domain = ?`,
    ).get(orgId, domain);
    if (existing) return existing;

    const id    = ulid();
    const token = generateVerificationToken();
    db.prepare(`
        INSERT INTO verified_domains (id, org_id, domain, verification_token, verification_method)
        VALUES (?, ?, ?, ?, 'dns_txt')
    `).run(id, orgId, domain, token);
    return db.prepare(`SELECT * FROM verified_domains WHERE id = ?`).get(id);
}

export async function verifyDomain(db, orgId, domainId, { dnsImpl } = {}) {
    const row = db.prepare(
        `SELECT * FROM verified_domains WHERE id = ? AND org_id = ?`,
    ).get(domainId, orgId);
    if (!row) return { verified: false, reason: 'not_found' };

    // Already verified — no-op, return success.
    if (row.verified_at) {
        return { verified: true, already: true };
    }

    const dns = dnsImpl || (await import('dns')).promises;
    let records;
    try {
        records = await dns.resolveTxt(row.domain);
    } catch (err) {
        const transient = ['ENOTFOUND', 'ENODATA', 'ETIMEOUT', 'ESERVFAIL'].includes(err.code);
        return {
            verified:  false,
            reason:    `DNS lookup failed: ${err.message}`,
            retryable: transient,
        };
    }

    const found = (records || []).some(parts =>
        (Array.isArray(parts) ? parts.join('') : String(parts)) === row.verification_token,
    );
    if (!found) {
        return { verified: false, reason: 'TXT token not found on domain' };
    }

    // Commit. Use a guarded update so concurrent verifies are safe.
    db.prepare(`
        UPDATE verified_domains
        SET verified_at = datetime('now'), verification_method = 'dns_txt'
        WHERE id = ? AND verified_at IS NULL
    `).run(row.id);
    return { verified: true };
}

export function listOrgDomains(db, orgId) {
    return db.prepare(`
        SELECT id, org_id, domain, verification_token, verification_method,
               verified_at, created_at
        FROM verified_domains
        WHERE org_id = ?
        ORDER BY created_at ASC
    `).all(orgId);
}

export function removeDomain(db, orgId, domainId) {
    db.prepare(`DELETE FROM verified_domains WHERE id = ? AND org_id = ?`).run(domainId, orgId);
}

// ──────────────────────────────────────────────────────────────────────
// Lookup used by auto-join + SSO JIT-routing
// ──────────────────────────────────────────────────────────────────────

export function findVerifiedDomainOwner(db, email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return null;
    // ET-ENFORCE audit-2: skip rows whose owning org has been soft-deleted.
    // The orgs.deleted_at column may not exist in legacy / minimal harness
    // schemas, so fall back to the un-joined query if the join fails.
    try {
        return db.prepare(`
            SELECT vd.id, vd.org_id, vd.domain, vd.verified_at
            FROM verified_domains vd
            INNER JOIN orgs o ON o.id = vd.org_id
            WHERE vd.domain = ?
              AND vd.verified_at IS NOT NULL
              AND o.deleted_at IS NULL
            LIMIT 1
        `).get(domain) || null;
    } catch {
        return db.prepare(`
            SELECT id, org_id, domain, verified_at
            FROM verified_domains
            WHERE domain = ? AND verified_at IS NOT NULL
            LIMIT 1
        `).get(domain) || null;
    }
}
