/**
 * internalServiceAuth.js — timing-safe X-Service-Key verification for
 * service-only routes (GDPR erase/export, and similar internal-caller-only
 * endpoints).
 *
 * SECURITY FIX (2026-09-25): the GDPR routes previously trusted a bare
 * `X-Internal-Service: auth-service` header with no secret comparison — any
 * caller could set that header to spoof the auth-service identity and
 * bulk-delete or exfiltrate another org's data (DELETE/GET
 * /api/v1/users/:userId/data, server.js). This module extracts the same
 * timing-safe INTERNAL_SERVICE_KEY compare already used elsewhere in
 * server.js (requireInstanceServiceKey ~line 3969, the
 * tool-definitions/install|uninstall gates ~5567/5712) into a small,
 * independently-unit-testable function — server.js itself boots a full
 * process on require() so it cannot be required directly in a test
 * (see test/stabilityAuditsServerJs.unit.test.js).
 *
 * Fails CLOSED: if INTERNAL_SERVICE_KEY is unset, every request is denied
 * (matches requireInstanceServiceKey's posture, not the fail-open shape used
 * by a few older inline checks in server.js — GDPR data is sensitive enough
 * to warrant the stricter default even before an operator sets the key).
 */

'use strict';

const { timingSafeEqual } = require('crypto');

/**
 * @param {import('express').Request} req
 * @returns {boolean} true iff req carries a valid X-Service-Key matching
 *   process.env.INTERNAL_SERVICE_KEY.
 */
function verifyInternalServiceKey(req) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY || '';
  const providedKey = (req && req.headers && req.headers['x-service-key']) || '';
  if (!expectedKey || !providedKey) return false;
  try {
    const bufA = Buffer.from(expectedKey);
    const bufB = Buffer.from(providedKey);
    if (bufA.length !== bufB.length) {
      // Constant-time dummy comparison to avoid leaking length info.
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Express middleware: fail-CLOSED internal service-key gate (F12).
 * 503 internal_key_not_configured when INTERNAL_SERVICE_KEY is unset/empty
 * (an unset key must never mean "open"); 401 on missing/mismatched key.
 */
function requireInternalServiceKey(req, res, next) {
  if (!process.env.INTERNAL_SERVICE_KEY) {
    console.error('[internal-auth] INTERNAL_SERVICE_KEY not set: denying internal route');
    return res.status(503).json({ error: 'internal_key_not_configured' });
  }
  if (!verifyInternalServiceKey(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = { verifyInternalServiceKey, requireInternalServiceKey };
