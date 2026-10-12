/**
 * VAULT-AUDIT P4.B — TLS Certificate Tool Executor
 *
 * Native executor for the `tls_cert_info` agent tool. Owns certificate
 * parsing only (Node's built-in crypto.X509Certificate) — credential
 * resolution, input validation, and response shaping live in agentTools.js.
 *
 * SECURITY: this module receives ONLY the public `certificate` PEM. It must
 * NEVER be handed the credential's `private_key` and never returns or logs
 * it. Zero external dependencies — parsing uses Node's built-in `crypto`.
 */

const { X509Certificate } = require('crypto');

/**
 * Parse a PEM-encoded X.509 certificate and return safe, public metadata.
 *
 * @param {string} pem - PEM-encoded certificate (public cert only)
 * @returns {{
 *   subject: string,
 *   issuer: string,
 *   valid_from: string,
 *   valid_to: string,
 *   days_until_expiry: number,
 *   fingerprint256: string,
 *   serial_number: string,
 *   subject_alt_name: string|null,
 * }}
 * @throws {Error} if the PEM cannot be parsed as an X.509 certificate.
 */
function parseCertificate(pem) {
  const cert = new X509Certificate(pem);

  const validTo = new Date(cert.validTo);
  const now = new Date();
  const days_until_expiry = Math.floor((validTo - now) / (1000 * 60 * 60 * 24));

  return {
    subject: cert.subject,
    issuer: cert.issuer,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    days_until_expiry,
    fingerprint256: cert.fingerprint256,
    serial_number: cert.serialNumber,
    subject_alt_name: cert.subjectAltName ?? null,
  };
}

module.exports = { parseCertificate };
