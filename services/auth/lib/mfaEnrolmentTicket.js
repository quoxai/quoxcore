/**
 * LAUNCH-SPINE — MFA enrolment ticket.
 *
 * Closes a deadlock in the MFA-required path: a user who has not enrolled is
 * refused at login with 403 `mfa_enrollment_required` and receives no session,
 * but both enrolment endpoints (`/mfa/setup`, `/mfa/verify-setup`) sit behind
 * `authenticate()`. The org's MFA requirement was therefore unsatisfiable for
 * anyone not already enrolled.
 *
 * A ticket is minted at that refusal, AFTER the password has been verified, and
 * authorises exactly one thing: enrolling this user in MFA.
 *
 * Deliberate properties, each of which exists to stop this becoming an auth
 * bypass:
 *   - Minted only after a successful password check. It is a second factor for
 *     a first factor already proven, not a way around the first factor.
 *   - Hashed at rest (SHA-256). The plaintext is returned once and is not
 *     recoverable from the table.
 *   - Short-lived (10 minutes).
 *   - Single-use, burned when enrolment completes.
 *   - Carries no role, no session id, and no token claims. It is accepted only
 *     by the two enrolment routes and grants nothing else.
 *   - Verifying does not consume, because /setup runs before /verify-setup and
 *     only completing enrolment should spend the ticket.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ulid } from '../utils/helpers.js';

/** 10 minutes. Long enough to scan a QR and type a code, short enough to be useless later. */
export const TICKET_TTL_MS = 10 * 60 * 1000;

function hash(ticket) {
    return createHash('sha256').update(ticket).digest('hex');
}

/**
 * Mint a ticket for a user who was just refused at login for not having MFA.
 *
 * @param {object} db - SQLite handle
 * @param {{userId: string, orgId?: string|null, ip?: string|null}} params
 * @returns {{ticket: string, record: object}} the plaintext ticket (return once) + stored row
 */
export function mintEnrolmentTicket(db, { userId, orgId = null, ip = null }) {
    if (!userId) throw new Error('mintEnrolmentTicket requires a userId');

    // 32 bytes of CSPRNG, base64url. Not a JWT: nothing about this should be
    // self-describing or independently verifiable off a stolen copy.
    const ticket = randomBytes(32).toString('base64url');
    const id = ulid();
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();

    db.prepare(`
        INSERT INTO mfa_enrolment_tickets (id, user_id, org_id, ticket_hash, expires_at, issued_ip)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, orgId, hash(ticket), expiresAt, ip);

    const record = db.prepare(`SELECT * FROM mfa_enrolment_tickets WHERE id = ?`).get(id);
    return { ticket, record };
}

/**
 * Check a ticket without spending it.
 *
 * @returns {{valid: boolean, reason?: string, userId?: string, orgId?: string|null, id?: string}}
 */
export function verifyEnrolmentTicket(db, ticket) {
    if (!ticket || typeof ticket !== 'string') return { valid: false, reason: 'missing' };

    const row = db.prepare(`SELECT * FROM mfa_enrolment_tickets WHERE ticket_hash = ?`).get(hash(ticket));
    if (!row) return { valid: false, reason: 'unknown' };

    // Constant-time compare on the hashes too. The lookup above is already
    // hash-keyed, but this keeps the comparison itself off the timing channel.
    const a = Buffer.from(row.ticket_hash, 'hex');
    const b = Buffer.from(hash(ticket), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'unknown' };

    if (row.consumed_at) return { valid: false, reason: 'consumed' };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'expired' };

    return { valid: true, userId: row.user_id, orgId: row.org_id, id: row.id };
}

/**
 * Spend a ticket. Call this only once enrolment has actually completed.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function consumeEnrolmentTicket(db, ticket, { ip = null } = {}) {
    const check = verifyEnrolmentTicket(db, ticket);
    if (!check.valid) return { ok: false, reason: check.reason };

    // Guarded UPDATE so two concurrent requests cannot both spend it: the
    // consumed_at IS NULL predicate makes the second one a no-op.
    const result = db.prepare(`
        UPDATE mfa_enrolment_tickets
        SET consumed_at = datetime('now'), consumed_ip = ?
        WHERE id = ? AND consumed_at IS NULL
    `).run(ip, check.id);

    if (result.changes !== 1) return { ok: false, reason: 'consumed' };
    return { ok: true, userId: check.userId, orgId: check.orgId };
}

/** Housekeeping: drop tickets that are long dead. Safe to call any time. */
export function pruneEnrolmentTickets(db) {
    return db.prepare(`
        DELETE FROM mfa_enrolment_tickets
        WHERE expires_at < datetime('now', '-1 day')
    `).run().changes;
}

export default {
    mintEnrolmentTicket,
    verifyEnrolmentTicket,
    consumeEnrolmentTicket,
    pruneEnrolmentTickets,
    TICKET_TTL_MS,
};
