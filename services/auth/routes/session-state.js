/**
 * routes/session-state.js — VAULT-AUDIT P3.B1 (F17)
 *
 * Internal service-key-guarded endpoints for server-side, envelope-encrypted
 * browser session state (credential_session_state). Consumers (e.g.
 * screencap) persist session cookies here instead of writing plaintext JSON
 * files to disk. Mirrors the internal-endpoint guard pattern used by
 * routes/setup.js's /api/setup/internal/credential-decrypt/:id — the SAME
 * authorizeInternalServiceRequest() guard, mounted alongside setupRoutes so
 * it sits BEFORE any /api/* router with requireAuth.
 *
 * Cookie VALUES are never logged or included in audit payloads — only
 * metadata (org, session_key, domain).
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { authorizeInternalServiceRequest } from '../utils/internalServiceAuth.js';
import { putSessionState, getSessionState, deleteSessionState } from '../db/sessionState.js';
import { evaluateLeaseGate } from '../lib/leaseGate.js';
import { writeLeaseAccessAudit } from '../lib/credentialReleaseAudit.js';

const router = Router();

function requireInternal(req, res) {
    const auth = authorizeInternalServiceRequest(req);
    if (!auth.authorized) {
        console.warn(`[Security] Rejected session-state request from: ${auth.clientIp} (${auth.reason})`);
        res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        return null;
    }
    return auth;
}

async function auditSessionState(auth, intent, { orgId, sessionKey, domain }) {
    try {
        const { emitEnvelope } = await import('../lib/aeeClient.js');
        emitEnvelope({
            from: `service.${auth?.service || 'internal'}`,
            to: 'audit.system',
            intent,
            corr: `VAULT_SESSION_${sessionKey}`,
            payload: {
                org_id: orgId,
                session_key: sessionKey,
                domain: domain || null,
                caller_service: auth?.service || 'internal',
            },
        });
    } catch (e) { /* audit is fire-and-forget */ }
}

/**
 * POST /api/setup/internal/session-state
 * body: { org_id, session_key, domain?, credential_id?, cookies }
 */
router.post('/internal/session-state', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, session_key, domain, credential_id, cookies } = req.body || {};
        if (!org_id || !session_key || !Array.isArray(cookies)) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id, session_key, and cookies (array) are required',
            });
        }

        const db = getDb();
        const result = putSessionState(db, {
            orgId: org_id,
            sessionKey: session_key,
            domain,
            credentialId: credential_id,
            cookies,
        });

        await auditSessionState(auth, 'quox.vault.session_state.write', { orgId: org_id, sessionKey: session_key, domain });

        res.json(result);
    } catch (err) {
        console.error('[Session State] Write error:', err);
        // F-2: never echo err.message to the client on a cookie-handling
        // endpoint (a JSON.parse error could embed decrypted bytes). The full
        // error stays in the server log above.
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * GET /api/setup/internal/session-state?org_id=&session_key=
 */
router.get('/internal/session-state', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, session_key } = req.query || {};
        if (!org_id || !session_key) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id and session_key are required',
            });
        }

        const db = getDb();
        const state = getSessionState(db, { orgId: org_id, sessionKey: session_key });
        if (!state) {
            return res.status(404).json({ error: 'not_found', message: 'No session state for this key' });
        }

        // VAULT-P5.G (F4): if this session is linked to a lease_required
        // credential, gate the read the same way the credential's own
        // decrypt path is gated.
        if (state.credential_id) {
            const agentId = req.query.agent_id || null;
            const leaseGate = evaluateLeaseGate({ orgId: org_id, agentId, credentialId: state.credential_id });
            if (!leaseGate.allow) {
                writeLeaseAccessAudit({
                    orgId: org_id, credentialId: state.credential_id, agentId,
                    outcome: 'lease_denied', reason: leaseGate.reason,
                    callerService: auth?.service || 'internal', via: 'session-state',
                });
                return res.status(403).json({ error: 'lease_required', message: 'An active lease is required to access this session', reason: leaseGate.reason });
            }
            if (leaseGate.advisory) {
                writeLeaseAccessAudit({
                    orgId: org_id, credentialId: state.credential_id, agentId,
                    outcome: 'lease_missing', reason: leaseGate.reason,
                    callerService: auth?.service || 'internal', via: 'session-state',
                });
            }
        }

        await auditSessionState(auth, 'quox.vault.session_state.read', { orgId: org_id, sessionKey: session_key });

        res.json(state);
    } catch (err) {
        console.error('[Session State] Read error:', err);
        // F-2: never echo err.message to the client on a cookie-handling
        // endpoint (a JSON.parse error could embed decrypted bytes). The full
        // error stays in the server log above.
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * DELETE /api/setup/internal/session-state?org_id=&session_key=
 */
router.delete('/internal/session-state', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, session_key } = req.query || {};
        if (!org_id || !session_key) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id and session_key are required',
            });
        }

        const db = getDb();
        const deleted = deleteSessionState(db, { orgId: org_id, sessionKey: session_key });

        await auditSessionState(auth, 'quox.vault.session_state.delete', { orgId: org_id, sessionKey: session_key });

        res.json({ deleted });
    } catch (err) {
        console.error('[Session State] Delete error:', err);
        // F-2: never echo err.message to the client on a cookie-handling
        // endpoint (a JSON.parse error could embed decrypted bytes). The full
        // error stays in the server log above.
        res.status(500).json({ error: 'internal_error' });
    }
});

export default router;
