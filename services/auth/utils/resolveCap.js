/**
 * ET-ENFORCE B — per-request capability resolver.
 *
 * Replaces the pattern
 *
 *     hasCapability({ orgRole: req.orgMembership.role }, Capabilities.X)
 *
 * which only considers the built-in role. `resolveCap(req, cap)` also
 * unions any custom role overlay carried on the membership, so routes
 * pick up custom_role_capabilities grants uniformly.
 *
 * Mirrors what `req.hasCap` provides when the full middleware chain
 * populates it, but works in contexts where req.orgMembership is
 * injected directly (e.g. test harnesses that skip requireOrgMembership).
 */

import { hasCapability } from './policy.js';
import { getDb } from '../db/index.js';

export function resolveCap(req, capability, { scopeId } = {}) {
    const principal = {
        type: 'user',
        id: req.user?.id,
        orgRole: req.orgMembership?.role,
        customRoleId: req.orgMembership?.custom_role_id || null,
    };
    const db = req.db || (() => { try { return getDb(); } catch { return null; } })();
    return hasCapability(principal, capability, {
        db,
        orgId: req.org?.id,
        scopeId,
    });
}
