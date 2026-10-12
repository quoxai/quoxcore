/**
 * TLS certificate expiry extraction.
 * VAULT-P7 follow-up: derive `expires_at` for tls_cert credentials from the
 * certificate's own X.509 notAfter field, so the vault doesn't rely on a
 * create-time input the UI never collects.
 */

import { X509Certificate } from 'crypto';

/**
 * Extract the X.509 notAfter ("valid to") date from a PEM certificate and
 * return it as an ISO 8601 string.
 *
 * Never throws — a malformed/dummy/empty PEM returns null so callers can
 * safely derive expires_at without guarding every call site.
 *
 * @param {string} pem - PEM-encoded certificate (the `certificate` field of
 *                        a tls_cert credential's `credentials` object).
 * @returns {string|null} ISO 8601 expiry timestamp, or null if it can't be
 *                        parsed.
 */
export function extractCertExpiry(pem) {
    if (!pem || typeof pem !== 'string') return null;

    try {
        const cert = new X509Certificate(pem);
        const validTo = new Date(cert.validTo);
        if (Number.isNaN(validTo.getTime())) return null;
        return validTo.toISOString();
    } catch (err) {
        return null;
    }
}

export default { extractCertExpiry };
