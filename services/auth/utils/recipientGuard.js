/**
 * QUOXTRUST S2 — recipient bounding for the instance SMTP send path.
 *
 * Context (FND_01M3CJJQSWWJN76YV35DWJN76Y): POST /api/notifications/send-email accepted
 * an arbitrary `to` (and a spoofable `from`) from any authenticated user, making the org
 * SMTP transport an authenticated open relay. This helper is the pure, testable core of
 * the containment: normalize + validate + cap the recipient list. The route additionally
 * forces `from` to the resolved org SMTP identity (no caller-supplied sender) and applies
 * a rate limiter. Full per-org recipient authorization belongs to the S3 reference monitor.
 *
 * Kept dependency-free so it can be reused by any send path (T6 egress bounds).
 */

// Deliberately conservative: single @, a dot in the domain, no whitespace. This is a
// containment check, not RFC 5322 validation — it exists to reject header-injection and
// obviously-bogus values, not to be maximally permissive.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DEFAULT_MAX_RECIPIENTS = 10;

/**
 * @param {string|string[]} to - a single address, comma-separated addresses, or an array.
 * @param {{ max?: number }} [opts]
 * @returns {{ ok: true, recipients: string[] } | { ok: false, error: string }}
 */
export function sanitizeRecipients(to, opts = {}) {
    const max = opts.max ?? DEFAULT_MAX_RECIPIENTS;

    let list;
    if (Array.isArray(to)) {
        list = to;
    } else if (typeof to === 'string') {
        list = to.split(',');
    } else {
        return { ok: false, error: 'Recipient must be a string or array of email addresses' };
    }

    const recipients = list.map((r) => String(r).trim()).filter(Boolean);

    if (recipients.length === 0) {
        return { ok: false, error: 'At least one recipient is required' };
    }
    if (recipients.length > max) {
        return { ok: false, error: `Too many recipients (max ${max})` };
    }
    // Reject anything with control chars / newlines outright (SMTP header injection).
    const injected = recipients.find((r) => /[\r\n]/.test(r));
    if (injected) {
        return { ok: false, error: 'Recipient contains illegal characters' };
    }
    const bad = recipients.find((r) => !EMAIL_RE.test(r));
    if (bad) {
        return { ok: false, error: `Invalid recipient address: ${bad}` };
    }

    return { ok: true, recipients };
}

export default { sanitizeRecipients };
