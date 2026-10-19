/**
 * quox#1197: service-key route backing the security_user_audit tool. ONE org's members with role, MFA on/off,
 * failed-login count, lockout and last activity (latest session use). Never the MFA secret or a token; never another
 * org's members. The collector calls it with the org from the caller's verified context, never from tool input.
 */
import { getDb } from '../db/index.js';

export function listOrgUserAudit(db, orgId) {
  return db.prepare(`
    SELECT u.id, u.primary_email AS email, u.display_name, u.status AS user_status,
           om.role, om.status AS membership_status, u.mfa_enabled, u.failed_login_count, u.lockout_until, u.created_at,
           (SELECT MAX(COALESCE(s.last_active_at, s.last_used_at, s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS last_active_at
    FROM org_memberships om JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ?
    ORDER BY last_active_at IS NOT NULL, last_active_at ASC
  `).all(orgId).map((r) => ({ ...r, mfa_enabled: r.mfa_enabled === 1 }));
}

export function internalOrgUserAuditHandler(req, res) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  const got = req.headers['x-service-key'];
  if (!expected || !got || got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({ org_id: req.params.orgId, users: listOrgUserAudit(getDb(), req.params.orgId) });
  } catch (err) {
    console.error('[UserAudit] internal list failed:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
}
