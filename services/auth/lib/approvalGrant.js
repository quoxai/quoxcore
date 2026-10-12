/**
 * approvalGrant.js — TRUST-PROOF slice 4: pure canonical builder for the
 * QuoxBastion X-Bastion-Approval-Grant envelope.
 *
 * Mirrors, field-for-field, QuoxBastion's internal/approval/grant.go Grant
 * struct and its signedBytes()/HashCommand()/HashParams(). The CANONICAL
 * CONTRACT is pinned by the cross-language test
 * internal/approval/xlang_test.go (Go decodes and verifies a grant minted
 * by the Node reference generator this module mirrors,
 * services/auth/scripts/approval-grant-fixture.mjs). Field order, the
 * omit-when-empty semantics on command_sha256/tool_id/params_sha256, and
 * the no-fractional-seconds RFC3339 timestamp format below MUST stay
 * byte-identical to that Go struct, or Go's decode -> re-marshal -> verify
 * round trip on a Node-minted grant breaks.
 *
 * Pure / side-effect-free (no DB, no signing, no network) — routes/
 * internal-approval-grants.js drives this + lib/approvalGrantSigningKey.js
 * (which holds the per-org Ed25519 key custody and does the actual signing)
 * together to mint a signed grant.
 */

import { createHash, randomBytes } from 'crypto';
import { ulid } from '../utils/helpers.js';

export const APPROVAL_GRANT_ACTIONS = Object.freeze({ EXEC: 'exec', TOOL: 'tool' });

const GRANT_ID_PREFIX = 'GRT_';
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;

/**
 * RFC3339 UTC timestamp with NO fractional seconds (e.g.
 * "2026-09-19T16:00:00Z"). Go's time.Time round-trips whatever precision it
 * was decoded with; minting at whole-second precision here is what keeps
 * Go's parse -> re-marshal byte-identical (see xlang_test.go).
 */
export function rfc3339NoFrac(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** hex sha256 of the raw command string — mirrors Go HashCommand(). */
export function hashCommand(command) {
    return createHash('sha256').update(String(command), 'utf8').digest('hex');
}

/**
 * hex sha256 of sorted "key=value\n" lines — mirrors Go HashParams(). Go's
 * side is map[string]string, so every value is stringified before hashing
 * (a non-string param value must already be caller-normalised to a string
 * before it reaches here, same contract Go's map type enforces).
 */
export function hashParams(params) {
    if (!params || typeof params !== 'object') return null;
    const keys = Object.keys(params).sort();
    let body = '';
    for (const k of keys) {
        body += `${k}=${String(params[k])}\n`;
    }
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Build the canonical field-ordered grant object (WITHOUT signature). Field
 * order and omission-when-empty MUST match Go's Grant struct declaration
 * order exactly: grant_id, org_id, action, command_sha256?, tool_id?,
 * params_sha256?, targets, nonce, issued_at, expires_at.
 */
export function canonicalGrant(g) {
    const out = {};
    out.grant_id = g.grant_id;
    out.org_id = g.org_id;
    out.action = g.action;
    if (g.command_sha256) out.command_sha256 = g.command_sha256;
    if (g.tool_id) out.tool_id = g.tool_id;
    if (g.params_sha256) out.params_sha256 = g.params_sha256;
    out.targets = g.targets;
    out.nonce = g.nonce;
    out.issued_at = g.issued_at;
    out.expires_at = g.expires_at;
    return out;
}

/**
 * The exact bytes the Ed25519 signature covers: JSON.stringify() of
 * canonicalGrant(g), as a Buffer. Mirrors Go's signedBytes() (json.Marshal
 * of the Grant struct with Signature blanked).
 */
export function signedBytes(g) {
    return Buffer.from(JSON.stringify(canonicalGrant(g)));
}

/**
 * Build an unsigned grant (grant_id/nonce minted, timestamps computed at
 * whole-second precision) ready for signedBytes() + signing. Does not
 * validate the action/command/toolId/params shape — routes/
 * internal-approval-grants.js validates the mint request before calling in.
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.action - 'exec' | 'tool'
 * @param {string} [opts.command] - raw command string (exec grants)
 * @param {string} [opts.toolId] - bastion tool id (tool grants)
 * @param {object} [opts.params] - tool params, stringified values (tool grants)
 * @param {string[]} opts.targets - host ids/aliases, or "group:<name>"
 * @param {number} [opts.ttlSeconds] - default 300, capped at 900
 * @returns {object} unsigned canonical grant fields (no signature)
 */
export function buildUnsignedGrant({ orgId, action, command, toolId, params, targets, ttlSeconds } = {}) {
    const ttl = Math.min(Math.max(parseInt(ttlSeconds, 10) || DEFAULT_TTL_SECONDS, 1), MAX_TTL_SECONDS);
    const issuedAtDate = new Date();
    const expiresAtDate = new Date(issuedAtDate.getTime() + ttl * 1000);
    return {
        grant_id: `${GRANT_ID_PREFIX}${ulid()}`,
        org_id: orgId,
        action,
        ...(command ? { command_sha256: hashCommand(command) } : {}),
        ...(toolId ? { tool_id: toolId } : {}),
        ...(params ? { params_sha256: hashParams(params) } : {}),
        targets: Array.isArray(targets) ? targets : [targets].filter(Boolean),
        nonce: randomBytes(16).toString('hex'),
        issued_at: rfc3339NoFrac(issuedAtDate),
        expires_at: rfc3339NoFrac(expiresAtDate),
    };
}

export const APPROVAL_GRANT_DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS;
export const APPROVAL_GRANT_MAX_TTL_SECONDS = MAX_TTL_SECONDS;
