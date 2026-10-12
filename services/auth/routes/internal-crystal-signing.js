/**
 * REPLAY-ONLY .B1a — per-org crystal signing oracle (auth-side)
 *
 * POST /api/internal/crystals/sign
 * GET  /api/internal/crystals/public-key/:orgId
 *
 * Architecture (decided, see docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md §5 ".B
 * scope correction"): quoxflow computes the canonical hash of a crystal's
 * action snapshot and sends the HASH to auth; auth is a PURE SIGNING ORACLE
 * — it signs opaque hash bytes with the org's Ed25519 Crystal Signing Key
 * (CSK) and never needs to understand crystal structure. The CSK private key
 * NEVER leaves auth (see lib/crystalSigningKey.js).
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same timing-safe pattern used
 * by routes/internal-orgs.js / routes/internal-tool-definitions.js. Fails
 * CLOSED when INTERNAL_SERVICE_KEY is not configured.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { ensureOrgCrystalSigningKey, signCrystalHash } from '../lib/crystalSigningKey.js';

const router = Router();

const HEX64_RE = /^[0-9a-f]{64}$/i;

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying crystals signing request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.post('/crystals/sign', (req, res) => {
    const { org_id: orgId, hash } = req.body || {};

    if (!orgId || typeof orgId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'org_id is required' });
    }
    if (!hash || typeof hash !== 'string' || !HEX64_RE.test(hash)) {
        return res.status(400).json({ error: 'bad_hash', message: 'hash must be a 64-character hex string (sha256 digest)' });
    }

    const db = req.db || getDb();
    let result;
    try {
        result = signCrystalHash(db, orgId, hash.toLowerCase());
    } catch (err) {
        console.error('[internal-crystal-signing] sign failed:', err.message);
        return res.status(500).json({ error: 'signing_failed', message: err.message });
    }

    return res.json({
        key_id: result.key_id,
        algorithm: result.algorithm,
        signature: result.signature,
        public_key_hex: result.public_key_hex,
    });
});

router.get('/crystals/public-key/:orgId', (req, res) => {
    const { orgId } = req.params;
    if (!orgId) {
        return res.status(400).json({ error: 'bad_request', message: 'orgId is required' });
    }

    const db = req.db || getDb();
    let keyRow;
    try {
        keyRow = ensureOrgCrystalSigningKey(db, orgId);
    } catch (err) {
        console.error('[internal-crystal-signing] public-key lookup failed:', err.message);
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
