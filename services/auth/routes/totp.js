/**
 * routes/totp.js — VAULT-AUDIT P3.C
 *
 * Internal service-key-guarded endpoint that computes the CURRENT TOTP code
 * for a web_login credential's `totp_secret` — the `vault_compute`
 * release-policy primitive. The seed NEVER leaves the vault: only the
 * 6-digit code (and its period/expiry) is returned. Mirrors the
 * internal-endpoint guard pattern used by routes/session-state.js — the SAME
 * authorizeInternalServiceRequest() guard, mounted alongside setupRoutes so
 * it sits BEFORE any /api/* router with requireAuth.
 *
 * The code and the seed are never logged or included in audit payloads —
 * only metadata (org_id, credential_id).
 */

import { Router } from 'express';
import { generate, createGuardrails } from 'otplib';
import { authorizeInternalServiceRequest } from '../utils/internalServiceAuth.js';
import { getDecryptedCredential } from '../db/integrations.js';
import { evaluateLeaseGate } from '../lib/leaseGate.js';
import { writeLeaseAccessAudit } from '../lib/credentialReleaseAudit.js';

const router = Router();

const TOTP_PERIOD_SECONDS = 30;

// otplib@13.2.1 defaults MIN_SECRET_BYTES to 16 (128 bits), which rejects the
// standard 16-char/80-bit Google Authenticator seed format used by most
// real-world setup pages. RFC-6238 and Google Authenticator both consider
// 80 bits (10 bytes) an acceptable minimum, so we relax the guardrail to that
// floor rather than accepting arbitrarily short secrets.
const TOTP_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 10 });

/**
 * Normalize a stored totp_secret before handing it to otplib: real-world
 * setup pages display seeds with spaces and/or lowercase letters (e.g.
 * "gezd gnbv gy3t qojq"), but base32 decoding requires an unbroken uppercase
 * string. Strips whitespace and dashes and uppercases the result.
 * NEVER logs the input or output — this touches raw secret material.
 * @param {string} secret
 * @returns {string}
 */
function normalizeTotpSecret(secret) {
    return String(secret).replace(/[\s-]+/g, '').toUpperCase();
}

function requireInternal(req, res) {
    const auth = authorizeInternalServiceRequest(req);
    if (!auth.authorized) {
        console.warn(`[Security] Rejected credential-totp request from: ${auth.clientIp} (${auth.reason})`);
        res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        return null;
    }
    return auth;
}

async function auditTotpCompute(auth, { orgId, credentialId }) {
    try {
        const { emitEnvelope } = await import('../lib/aeeClient.js');
        emitEnvelope({
            from: `service.${auth?.service || 'internal'}`,
            to: 'audit.system',
            intent: 'quox.vault.totp.compute',
            corr: `VAULT_TOTP_${credentialId}`,
            payload: {
                org_id: orgId,
                credential_id: credentialId,
                caller_service: auth?.service || 'internal',
            },
        });
    } catch (e) { /* audit is fire-and-forget */ }
}

/**
 * GET /api/setup/internal/credential-totp/:id?org_id=
 * Computes the current TOTP code from a web_login credential's totp_secret.
 * Returns ONLY { code, period, expires_in } — never the seed.
 */
router.get('/internal/credential-totp/:id', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { id } = req.params;
        const orgId = req.query.org_id;

        if (!orgId) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id is required',
            });
        }

        const credential = getDecryptedCredential(id);
        if (!credential) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        // Org check enforced — stricter than credential-decrypt's skip. A
        // cross-org caller gets the same 404 as a missing credential so the
        // response can't be used as an existence oracle.
        if (credential.org_id !== orgId) {
            return res.status(404).json({ error: 'not_found', message: 'Credential not found' });
        }

        const totpSecret = credential.credentials?.totp_secret;
        if (credential.credential_kind !== 'web_login' || !totpSecret) {
            return res.status(404).json({ error: 'no_totp', message: 'Credential has no totp_secret' });
        }

        // VAULT-P5.G (F4): lease enforcement gate — same contract as
        // routes/integrations.js POST /internal/integrations/:id/decrypt.
        const agentId = req.query.agent_id || null;
        const leaseGate = evaluateLeaseGate({ orgId, agentId, credentialId: credential.id });
        if (!leaseGate.allow) {
            writeLeaseAccessAudit({
                orgId, credentialId: credential.id, integrationType: credential.credential_kind,
                label: credential.label, agentId, outcome: 'lease_denied', reason: leaseGate.reason,
                callerService: auth?.service || 'internal', via: 'credential-totp',
            });
            return res.status(403).json({ error: 'lease_required', message: 'An active lease is required to compute this TOTP code', reason: leaseGate.reason });
        }
        if (leaseGate.advisory) {
            writeLeaseAccessAudit({
                orgId, credentialId: credential.id, integrationType: credential.credential_kind,
                label: credential.label, agentId, outcome: 'lease_missing', reason: leaseGate.reason,
                callerService: auth?.service || 'internal', via: 'credential-totp',
            });
        }

        const normalizedSecret = normalizeTotpSecret(totpSecret);
        const code = await generate({ secret: normalizedSecret, guardrails: TOTP_GUARDRAILS });
        const nowSeconds = Math.floor(Date.now() / 1000);
        const expires_in = TOTP_PERIOD_SECONDS - (nowSeconds % TOTP_PERIOD_SECONDS);

        await auditTotpCompute(auth, { orgId, credentialId: credential.id });

        res.json({
            code,
            period: TOTP_PERIOD_SECONDS,
            expires_in,
        });
    } catch (err) {
        console.error('[Credential TOTP] Error:', err);
        // Never echo err.message — could embed decrypted bytes on a
        // crypto-handling endpoint. Full error stays in the server log above.
        res.status(500).json({ error: 'internal_error' });
    }
});

export default router;
