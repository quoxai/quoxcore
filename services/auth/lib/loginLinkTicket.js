/**
 * QUOXON-C2c: one-time dashboard sign-in link ticket.
 *
 * A fresh install ends with the CLI signed in and the browser not. The CLI asks
 * for a ticket (POST /api/auth/login-link, as the signed-in owner) and prints a
 * link; opening it once installs a normal browser session for the same user in
 * the same org (GET /api/auth/login-link/consume).
 *
 * Properties that keep it from being a reusable credential (pattern of
 * mfaEnrolmentTicket.js):
 *   - 32 bytes of CSPRNG, base64url. Not a JWT: nothing self-describing.
 *   - Hashed at rest (SHA-256); the plaintext is returned once.
 *   - 10 minute TTL.
 *   - Single-use: a guarded UPDATE so two concurrent opens cannot both spend it.
 *   - Bound to one user AND one org; minting needs both.
 */
import { createHash, randomBytes } from 'crypto';
import { ulid } from '../utils/helpers.js';

export const LOGIN_LINK_TTL_MS = 10 * 60 * 1000;

const hash = (ticket) => createHash('sha256').update(ticket).digest('hex');

/** -> { ticket (plaintext, return once), id, expiresAt } */
export function mintLoginLinkTicket(db, { userId, orgId, ip = null, now = Date.now() } = {}) {
    if (!userId) throw new Error('mintLoginLinkTicket requires a userId');
    if (!orgId) throw new Error('mintLoginLinkTicket requires an orgId');
    const ticket = randomBytes(32).toString('base64url');
    const id = ulid();
    const expiresAt = new Date(now + LOGIN_LINK_TTL_MS).toISOString();
    db.prepare(`
        INSERT INTO login_link_tickets (id, user_id, org_id, ticket_hash, expires_at, issued_ip)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, orgId, hash(ticket), expiresAt, ip);
    return { ticket, id, expiresAt };
}

/**
 * Spend a ticket. -> { ok: true, id, userId, orgId } | { ok: false, reason }
 * reason: missing | unknown | consumed | expired
 */
export function consumeLoginLinkTicket(db, ticket, { ip = null, now = Date.now() } = {}) {
    if (!ticket || typeof ticket !== 'string') return { ok: false, reason: 'missing' };
    const row = db.prepare('SELECT * FROM login_link_tickets WHERE ticket_hash = ?').get(hash(ticket));
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.consumed_at) return { ok: false, reason: 'consumed' };
    if (new Date(row.expires_at).getTime() <= now) return { ok: false, reason: 'expired' };
    const result = db.prepare(`
        UPDATE login_link_tickets
        SET consumed_at = datetime('now'), consumed_ip = ?
        WHERE id = ? AND consumed_at IS NULL
    `).run(ip, row.id);
    if (result.changes !== 1) return { ok: false, reason: 'consumed' };
    return { ok: true, id: row.id, userId: row.user_id, orgId: row.org_id };
}

/** Housekeeping: drop tickets dead for more than a day. */
export function pruneLoginLinkTickets(db) {
    return db.prepare(`DELETE FROM login_link_tickets WHERE expires_at < datetime('now', '-1 day')`).run().changes;
}

export default { mintLoginLinkTicket, consumeLoginLinkTicket, pruneLoginLinkTickets, LOGIN_LINK_TTL_MS };
