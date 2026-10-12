/**
 * TRUST-PROOF slice 4 — Auth-side approval-grant minting oracle for
 * QuoxBastion's X-Bastion-Approval-Grant gate.
 *
 * POST /api/internal/approval-grants/mint
 * GET  /api/internal/approval-grants/public-key?org_id=...
 *
 * Architecture: when the collector executes a bastion exec/tool call whose
 * requiresApproval gate (lib/approvalGate.js -> withApprovalGate) has just
 * been resolved by a human via the HITL inbox, it calls in here with the
 * inbox item id plus the EXACT command (or tool id + params) and targets
 * about to be executed. This route:
 *   1. Loads the HITL inbox item by item_id — REQUIRES it to be a
 *      kind:'approval' item resolved with a non-deny decision (409
 *      otherwise), and REQUIRES that resolution happened within the last
 *      15 minutes (a grant must follow its approval promptly).
 *   2. org_id is read FROM THE ITEM, never from the request body — the
 *      same signing-oracle-shape avoidance flagged in
 *      routes/internal-dev-profile-signing.js's TODO(SEC-FLEET-CRED): a
 *      caller must not be able to mint a grant "as" an arbitrary org just
 *      by naming it in the body.
 *   3. Builds the canonical grant (lib/approvalGrant.js) binding the exact
 *      command/tool+params and targets, signs it with the org's Approval
 *      Grant Signing Key (lib/approvalGrantSigningKey.js — the private key
 *      never leaves this service), and returns the signed envelope both as
 *      a plain object and as the base64 string QuoxBastion expects on the
 *      X-Bastion-Approval-Grant header.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), same constant-time pattern
 * used by every other /api/internal router (see routes/inbox.js
 * internalRouter's requireInternalAuth, mirrored here rather than imported
 * since inbox.js does not export it). Fails CLOSED when
 * INTERNAL_SERVICE_KEY is not configured.
 */

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/index.js';
import { isDenyAction } from '../lib/inboxResponseClassifier.js';
import {
    ensureOrgApprovalGrantSigningKey,
    signApprovalGrant,
    getApprovalGrantPublicKey,
} from '../lib/approvalGrantSigningKey.js';
import {
    APPROVAL_GRANT_ACTIONS,
    APPROVAL_GRANT_MAX_TTL_SECONDS,
    buildUnsignedGrant,
    signedBytes,
} from '../lib/approvalGrant.js';

const router = Router();

const VALID_ACTIONS = new Set(Object.values(APPROVAL_GRANT_ACTIONS));

// A grant must follow its approval promptly — 15 minutes, matching the
// task's HITL-freshness bar (the same window a human would still recognise
// "yes, I just approved that").
const MAX_APPROVAL_AGE_MS = 15 * 60 * 1000;

// QUOXTRUST #626 (A) — engagement-anchored grants. A governed security scan
// (discovery/safe_active tier) is pre-authorized by an ACTIVE security
// engagement whose target the operator dns_txt-verified and whose risk_ceiling
// they set — the engagement IS the human authorization, the twin of an inbox
// approval for intrusive ops. The engagement store lives ONLY in the collector's
// security.db (auth cannot read it), so this route re-validates the engagement
// authorization by an INDEPENDENT keyed callback to the collector's check-policy
// endpoint BEFORE signing (defense-in-depth against a collector-side path that
// reaches mint without the policy gate), then signs a normal short-TTL grant.
// FAILS CLOSED on any non-allowed / unreachable / error result.
const COLLECTOR_INTERNAL_URL =
    process.env.COLLECTOR_INTERNAL_URL ||
    process.env.COLLECTOR_URL ||
    process.env.QUOX_COLLECTOR_URL ||
    'http://collector:9848';

async function defaultCheckEngagementAuthorization({ orgId, engagementId, target, capabilityRisk }) {
    const expected = process.env.INTERNAL_SERVICE_KEY;
    if (!expected) return { allowed: false, reason: 'INTERNAL_SERVICE_KEY not configured' };
    try {
        const resp = await fetch(
            `${COLLECTOR_INTERNAL_URL}/api/v1/security/engagements/${encodeURIComponent(engagementId)}/check-policy`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Service-Key': expected },
                body: JSON.stringify({ org_id: orgId, target_value: target, capability_risk: capabilityRisk }),
                signal: AbortSignal.timeout(10000),
            },
        );
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { allowed: false, reason: `collector check-policy returned ${resp.status}: ${text.slice(0, 200)}` };
        }
        const data = await resp.json().catch(() => null);
        return {
            allowed: !!(data && data.success === true && data.allowed === true),
            reason: data && data.reason,
        };
    } catch (err) {
        return { allowed: false, reason: `collector check-policy error: ${err.message}` };
    }
}

// Injectable for tests (no live collector). Reset to the real callback with __setEngagementChecker(null).
let _checkEngagementAuthorization = defaultCheckEngagementAuthorization;
export function __setEngagementChecker(fn) {
    _checkEngagementAuthorization = typeof fn === 'function' ? fn : defaultCheckEngagementAuthorization;
}

function requireInternalAuth(req, res, next) {
    const expected = process.env.INTERNAL_SERVICE_KEY;
    if (!expected) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying approval-grant request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const provided = req.headers['x-service-key'];
    if (typeof provided === 'string') {
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length === b.length && timingSafeEqual(a, b)) return next();
    }
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

/**
 * SQLite's `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" (space
 * separator, no zone suffix) in UTC. Node's bare Date parser treats that
 * shape as local time in some engines, which is wrong here — normalise to
 * a real UTC ISO string before parsing.
 */
function parseSqliteUtcTimestamp(value) {
    if (!value || typeof value !== 'string') return null;
    const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const normalized = iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

router.post('/approval-grants/mint', (req, res) => {
    const {
        item_id: itemId,
        action,
        command,
        tool_id: toolId,
        params,
        targets,
        ttl_seconds: ttlSeconds,
    } = req.body || {};

    if (!itemId || typeof itemId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'item_id is required' });
    }
    if (!VALID_ACTIONS.has(action)) {
        return res.status(400).json({
            error: 'bad_request',
            message: `action must be one of: ${[...VALID_ACTIONS].join(', ')}`,
        });
    }
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string' && t)) {
        return res.status(400).json({ error: 'bad_request', message: 'targets must be a non-empty array of strings' });
    }
    if (action === APPROVAL_GRANT_ACTIONS.EXEC && (typeof command !== 'string' || !command)) {
        return res.status(400).json({ error: 'bad_request', message: 'command is required for action=exec' });
    }
    if (action === APPROVAL_GRANT_ACTIONS.TOOL && (typeof toolId !== 'string' || !toolId)) {
        return res.status(400).json({ error: 'bad_request', message: 'tool_id is required for action=tool' });
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
        return res.status(400).json({ error: 'bad_request', message: 'params must be an object when provided' });
    }
    if (ttlSeconds !== undefined && (!Number.isFinite(Number(ttlSeconds)) || Number(ttlSeconds) > APPROVAL_GRANT_MAX_TTL_SECONDS)) {
        return res.status(400).json({
            error: 'bad_request',
            message: `ttl_seconds must be a number <= ${APPROVAL_GRANT_MAX_TTL_SECONDS}`,
        });
    }

    const db = req.db || getDb();

    const item = db.prepare(`SELECT * FROM inbox_items WHERE id = ? AND deleted_at IS NULL`).get(itemId);
    if (!item) {
        return res.status(404).json({ error: 'not_found', message: 'Inbox item not found' });
    }
    if (item.kind !== 'approval') {
        return res.status(409).json({ error: 'not_approved', message: 'Inbox item is not an approval item' });
    }
    if (item.status !== 'resolved') {
        return res.status(409).json({
            error: 'not_approved',
            message: `Inbox item status is '${item.status}', not approved`,
        });
    }

    let response = null;
    try {
        response = item.response_json ? JSON.parse(item.response_json) : null;
    } catch {
        response = null;
    }
    if (!response || isDenyAction(response.action)) {
        return res.status(409).json({ error: 'not_approved', message: 'Inbox item was not granted (denied or no recorded decision)' });
    }

    const resolvedAtMs = parseSqliteUtcTimestamp(item.resolved_at);
    if (resolvedAtMs === null) {
        return res.status(409).json({ error: 'not_approved', message: 'Inbox item has no resolved_at timestamp' });
    }
    if (Date.now() - resolvedAtMs > MAX_APPROVAL_AGE_MS) {
        return res.status(409).json({
            error: 'approval_stale',
            message: `Approval is more than ${MAX_APPROVAL_AGE_MS / 60000} minutes old; re-approve to mint a grant`,
        });
    }

    // org_id comes FROM THE ITEM — never from the request body.
    const orgId = item.org_id;

    const unsignedGrant = buildUnsignedGrant({
        orgId,
        action,
        command: action === APPROVAL_GRANT_ACTIONS.EXEC ? command : undefined,
        toolId: action === APPROVAL_GRANT_ACTIONS.TOOL ? toolId : undefined,
        params: action === APPROVAL_GRANT_ACTIONS.TOOL ? (params || undefined) : undefined,
        targets,
        ttlSeconds,
    });

    let signResult;
    try {
        signResult = signApprovalGrant(db, orgId, signedBytes(unsignedGrant));
    } catch (err) {
        console.error('[internal-approval-grants] sign failed:', err.message);
        return res.status(500).json({ error: 'signing_failed', message: err.message });
    }

    const grant = { ...unsignedGrant, signature: signResult.signature };
    const grantBase64 = Buffer.from(JSON.stringify(grant)).toString('base64');

    return res.json({
        grant,
        grant_base64: grantBase64,
        header_name: 'X-Bastion-Approval-Grant',
    });
});

// QUOXTRUST #626 (A) — engagement-anchored grant mint (see the header block by
// COLLECTOR_INTERNAL_URL). `targets` is the bastion HOST(s) the command runs ON
// (the scan host); `target` is the in-scope engagement asset being scanned
// (e.g. a domain), used only for the independent policy recheck. exec-only:
// scans are shell commands, never bastion built-in tools.
router.post('/approval-grants/mint-engagement', async (req, res) => {
    const {
        org_id: orgId,
        engagement_id: engagementId,
        action,
        command,
        targets,
        target,
        capability_risk: capabilityRisk,
        ttl_seconds: ttlSeconds,
    } = req.body || {};

    if (!orgId || typeof orgId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'org_id is required' });
    }
    if (!engagementId || typeof engagementId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'engagement_id is required' });
    }
    if (action !== APPROVAL_GRANT_ACTIONS.EXEC) {
        return res.status(400).json({ error: 'bad_request', message: 'action must be "exec" for engagement grants' });
    }
    if (typeof command !== 'string' || !command) {
        return res.status(400).json({ error: 'bad_request', message: 'command is required' });
    }
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string' && t)) {
        return res.status(400).json({ error: 'bad_request', message: 'targets must be a non-empty array of strings (the scan host)' });
    }
    if (!target || typeof target !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'target (the in-scope engagement asset) is required' });
    }
    if (!capabilityRisk || typeof capabilityRisk !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'capability_risk is required' });
    }
    if (ttlSeconds !== undefined && (!Number.isFinite(Number(ttlSeconds)) || Number(ttlSeconds) > APPROVAL_GRANT_MAX_TTL_SECONDS)) {
        return res.status(400).json({
            error: 'bad_request',
            message: `ttl_seconds must be a number <= ${APPROVAL_GRANT_MAX_TTL_SECONDS}`,
        });
    }

    // INDEPENDENT engagement-authorization recheck — FAIL CLOSED. The signer
    // does not take the collector's word for it; it re-runs the engagement
    // policy (verified target, risk within ceiling, within time-window) via the
    // keyed callback and refuses to sign on anything but an explicit allow.
    let authz;
    try {
        authz = await _checkEngagementAuthorization({ orgId, engagementId, target, capabilityRisk });
    } catch (err) {
        return res.status(502).json({ error: 'engagement_check_failed', message: err && err.message ? err.message : 'engagement authorization check threw' });
    }
    if (!authz || authz.allowed !== true) {
        return res.status(409).json({
            error: 'not_authorized',
            message: (authz && authz.reason) ? authz.reason : 'engagement does not authorize this scan',
        });
    }

    const db = req.db || getDb();
    const unsignedGrant = buildUnsignedGrant({ orgId, action, command, targets, ttlSeconds });

    let signResult;
    try {
        signResult = signApprovalGrant(db, orgId, signedBytes(unsignedGrant));
    } catch (err) {
        console.error('[internal-approval-grants] engagement sign failed:', err.message);
        return res.status(500).json({ error: 'signing_failed', message: err.message });
    }

    const grant = { ...unsignedGrant, signature: signResult.signature };
    const grantBase64 = Buffer.from(JSON.stringify(grant)).toString('base64');

    return res.json({
        grant,
        grant_base64: grantBase64,
        header_name: 'X-Bastion-Approval-Grant',
        anchor: 'engagement',
        engagement_id: engagementId,
    });
});

router.get('/approval-grants/public-key', (req, res) => {
    const orgId = req.query.org_id;
    if (!orgId || typeof orgId !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'org_id query parameter is required' });
    }

    const db = req.db || getDb();
    let keyRow;
    try {
        keyRow = getApprovalGrantPublicKey(db, orgId);
    } catch (err) {
        console.error('[internal-approval-grants] public-key lookup failed:', err.message);
        return res.status(500).json({ error: 'keygen_failed', message: err.message });
    }

    return res.json(keyRow);
});

export default router;

// Exported for tests only — not part of the route's runtime path.
export const __test__ = { parseSqliteUtcTimestamp, ensureOrgApprovalGrantSigningKey };
