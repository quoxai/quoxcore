/**
 * DEVSUITE-HUB Phase 2 foundation — per-org dev capability profile signing
 * oracle (auth-side)
 *
 * POST /api/internal/dev-profiles/sign
 * GET  /api/internal/dev-profiles/public-key/:orgId
 *
 * Architecture (mirrors routes/internal-crystal-signing.js exactly):
 * whatever issues a quoxagent dev.* CapabilityProfile
 * (internal/plugins/dev/profile.go) computes the canonical bytes
 * buildProfileSignedData() would produce for that profile and sends those
 * bytes (hex-encoded) to auth; auth is a PURE SIGNING ORACLE — it signs the
 * opaque bytes with the org's Ed25519 Dev Capability Signing Key (DCSK) and
 * never needs to understand capability-profile structure. The DCSK private
 * key NEVER leaves auth (see lib/devCapabilitySigningKey.js). This is a
 * DEDICATED keypair — never the same key material as the Crystal Signing
 * Key (org_crystal_signing_keys) or any other secret in this service.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used
 * by routes/internal-crystal-signing.js / routes/internal-orgs.js /
 * routes/internal-tool-definitions.js. Fails CLOSED when
 * INTERNAL_SERVICE_KEY is not configured.
 *
 * TODO(SEC-FLEET-CRED): this endpoint trusts org_id straight from the
 * request body under the SAME shared INTERNAL_SERVICE_KEY every same-box
 * trusted internal service holds — fine for those callers, but if a REMOTE
 * FLEET HOST (quoxagent, running on arbitrary managed hosts, potentially
 * compromised) is ever handed that master key or a call path to this route,
 * it could sign a CapabilityProfile as ANY org_id. That exact pattern was
 * just fixed one hop over in the collector
 * (services/collector/lib/fleetGripeHandler.js /
 * fleetHostCredentialsStore.js): a per-host token, issued once at
 * enrollment and bound to a specific org_id, resolved server-side instead
 * of trusted from the body. Today nothing routes a fleet host directly to
 * this endpoint (quoxagent's profile.go presumably calls it via some
 * same-box intermediary — not audited as part of this pass), so this is
 * not confirmed exploitable, but this route still uses the old
 * shared-key-only pattern and needs the same migration once a real
 * fleet-host call path to it exists.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { ensureOrgDevCapabilitySigningKey, signDevCapabilityProfile } from '../lib/devCapabilitySigningKey.js';
import { validateCanonicalProfileBytes } from '../lib/devProfileCanonical.js';
import { validateCanonicalInvokeBytes } from '../lib/devInvokeCanonical.js';

// The oracle signs exactly TWO domain-separated byte shapes, never arbitrary
// blobs (quox#586). The caller declares which via `kind`; each shape has its
// own strict validator + canonical re-serialisation lock. Default 'profile'
// keeps the pre-#586 contract for existing profile-issuer callers.
const KIND_VALIDATORS = {
    profile: { validate: validateCanonicalProfileBytes, refusal: 'not_a_profile' },
    invoke: { validate: validateCanonicalInvokeBytes, refusal: 'not_an_invoke' },
};

const router = Router();

// Canonical bytes are the hex-encoded UTF-8 JSON produced by quoxagent's
// buildProfileSignedData() (a small map of profile fields), not a fixed-
// length digest — validate as well-formed, even-length hex with a generous
// upper bound (64KiB of JSON) rather than a fixed length.
const HEX_RE = /^[0-9a-f]+$/i;
const MAX_CANONICAL_BYTES_HEX_LEN = 131072; // 64 KiB of raw bytes, hex-encoded

function isValidCanonicalBytesHex(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length % 2 === 0
        && value.length <= MAX_CANONICAL_BYTES_HEX_LEN
        && HEX_RE.test(value);
}

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying dev-profiles signing request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.post('/dev-profiles/sign', (req, res) => {
    const { org_id: orgId, canonical_bytes_hex: canonicalBytesHex, kind: rawKind } = req.body || {};

    if (!orgId || typeof orgId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'org_id is required' });
    }
    // Default 'profile' preserves the pre-#586 contract (the profile issuer
    // sends no `kind`); fleet dev-invoke callers send kind:'invoke'.
    const kind = rawKind === undefined || rawKind === null ? 'profile' : rawKind;
    const validator = KIND_VALIDATORS[kind];
    if (!validator) {
        return res.status(400).json({
            error: 'bad_kind',
            message: `kind must be one of: ${Object.keys(KIND_VALIDATORS).join(', ')}`,
        });
    }
    if (!isValidCanonicalBytesHex(canonicalBytesHex)) {
        return res.status(400).json({
            error: 'bad_canonical_bytes',
            message: 'canonical_bytes_hex must be a non-empty, even-length hex string (<=64KiB) — the exact hex-encoded bytes the caller wants signed',
        });
    }

    // TRUST-PROOF audit cycle 1 + quox#586: never a blind oracle. The bytes
    // must BE a well-formed, canonically-serialized instance of the DECLARED
    // shape (profile via devProfileCanonical, invoke via devInvokeCanonical) —
    // the signature still covers the exact original bytes, we just refuse to
    // sign anything that isn't one of the two shapes this key exists to sign.
    const shape = validator.validate(Buffer.from(canonicalBytesHex, 'hex'));
    if (!shape.ok) {
        return res.status(400).json({
            error: validator.refusal,
            message: `refusing to sign: ${shape.reason}`,
        });
    }

    const db = req.db || getDb();
    let result;
    try {
        result = signDevCapabilityProfile(db, orgId, canonicalBytesHex.toLowerCase());
    } catch (err) {
        console.error('[internal-dev-profile-signing] sign failed:', err.message);
        return res.status(500).json({ error: 'signing_failed', message: err.message });
    }

    return res.json({
        key_id: result.key_id,
        algorithm: result.algorithm,
        signature: result.signature,
        public_key_hex: result.public_key_hex,
    });
});

router.get('/dev-profiles/public-key/:orgId', (req, res) => {
    const { orgId } = req.params;
    if (!orgId) {
        return res.status(400).json({ error: 'bad_request', message: 'orgId is required' });
    }

    const db = req.db || getDb();
    let keyRow;
    try {
        keyRow = ensureOrgDevCapabilitySigningKey(db, orgId);
    } catch (err) {
        console.error('[internal-dev-profile-signing] public-key lookup failed:', err.message);
        return res.status(500).json({ error: 'keygen_failed', message: err.message });
    }

    return res.json({
        key_id: keyRow.key_id,
        algorithm: keyRow.algorithm,
        public_key_hex: keyRow.public_key_hex,
        status: keyRow.status,
    });
});

export default router;
