/**
 * routes/ssh-known-hosts.js — VAULT-AUDIT P4.A-auth
 *
 * Internal service-key-guarded endpoints for the durable, org-scoped SSH
 * known-hosts store (ssh_known_hosts). The collector SSH executor calls
 * these to enforce TOFU (trust-on-first-use) + drift detection before
 * connecting to a host over SSH — a container-local known_hosts file dies
 * on rebuild, a ZERO-TOLERANCE server-side-persistence violation. Mirrors
 * the internal-endpoint guard pattern used by routes/session-state.js — the
 * SAME authorizeInternalServiceRequest() guard, mounted alongside
 * setupRoutes so it sits BEFORE any /api/* router with requireAuth.
 *
 * SSH host public keys are NOT secret — no encryption, no ENCRYPTED_STORES
 * registration (contrast with routes/session-state.js, which handles
 * encrypted cookie values and never echoes err.message).
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { authorizeInternalServiceRequest } from '../utils/internalServiceAuth.js';
import { verifyOrRecordHostKey, getKnownHost, deleteKnownHost } from '../db/sshKnownHosts.js';

const router = Router();

function requireInternal(req, res) {
    const auth = authorizeInternalServiceRequest(req);
    if (!auth.authorized) {
        console.warn(`[Security] Rejected ssh-known-host request from: ${auth.clientIp} (${auth.reason})`);
        res.status(403).json({ error: 'forbidden', message: 'Internal endpoint only' });
        return null;
    }
    return auth;
}

async function auditSshKnownHost(auth, intent, { orgId, host, port, status }) {
    try {
        const { emitEnvelope } = await import('../lib/aeeClient.js');
        emitEnvelope({
            from: `service.${auth?.service || 'internal'}`,
            to: 'audit.system',
            intent,
            corr: `VAULT_SSH_KNOWN_HOST_${orgId}_${host}_${port}`,
            payload: {
                org_id: orgId,
                host,
                port,
                status,
                caller_service: auth?.service || 'internal',
            },
        });
    } catch (e) { /* audit is fire-and-forget */ }
}

function parsePort(value) {
    const port = parseInt(value, 10);
    return Number.isFinite(port) && port > 0 ? port : 22;
}

/**
 * POST /api/setup/internal/ssh-known-host
 * body: { org_id, host, port?, fingerprint, key_type? }
 * 200 { status: 'first_use' | 'ok' }
 * 409 { status: 'drift', stored } — possible MITM, caller must abort
 */
router.post('/internal/ssh-known-host', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, host, port, fingerprint, key_type } = req.body || {};
        if (!org_id || !host || !fingerprint) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id, host, and fingerprint are required',
            });
        }

        const db = getDb();
        const resolvedPort = port !== undefined ? parsePort(port) : 22;
        const result = verifyOrRecordHostKey(db, {
            orgId: org_id,
            host,
            port: resolvedPort,
            fingerprint,
            keyType: key_type,
        });

        if (result.status === 'drift') {
            await auditSshKnownHost(auth, 'quox.vault.ssh_host.drift', { orgId: org_id, host, port: resolvedPort, status: result.status });
            return res.status(409).json(result);
        }

        await auditSshKnownHost(auth, 'quox.vault.ssh_host.verify', { orgId: org_id, host, port: resolvedPort, status: result.status });

        res.json(result);
    } catch (err) {
        console.error('[SSH Known Hosts] Write error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * GET /api/setup/internal/ssh-known-host?org_id=&host=&port=
 */
router.get('/internal/ssh-known-host', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, host, port } = req.query || {};
        if (!org_id || !host) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id and host are required',
            });
        }

        const db = getDb();
        const resolvedPort = port !== undefined ? parsePort(port) : 22;
        const row = getKnownHost(db, { orgId: org_id, host, port: resolvedPort });
        if (!row) {
            return res.status(404).json({ error: 'not_found', message: 'No known host for this key' });
        }

        res.json(row);
    } catch (err) {
        console.error('[SSH Known Hosts] Read error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

/**
 * DELETE /api/setup/internal/ssh-known-host?org_id=&host=&port=
 * Explicit operator-rotation escape hatch.
 */
router.delete('/internal/ssh-known-host', async (req, res) => {
    try {
        const auth = requireInternal(req, res);
        if (!auth) return;

        const { org_id, host, port } = req.query || {};
        if (!org_id || !host) {
            return res.status(400).json({
                error: 'invalid_request',
                message: 'org_id and host are required',
            });
        }

        const db = getDb();
        const resolvedPort = port !== undefined ? parsePort(port) : 22;
        const deleted = deleteKnownHost(db, { orgId: org_id, host, port: resolvedPort });

        await auditSshKnownHost(auth, 'quox.vault.ssh_host.delete', { orgId: org_id, host, port: resolvedPort, status: 'deleted' });

        res.json({ deleted });
    } catch (err) {
        console.error('[SSH Known Hosts] Delete error:', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

export default router;
