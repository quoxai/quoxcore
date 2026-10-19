'use strict';
/**
 * Org for an AGH-chain read. A user caller is scoped by their own token. The collector's own
 * tools (agh_chain_leaderboard) self-fetch with the internal service key, which takes priority in
 * requireServiceOrUserAuth, so req.user is unset and every agent read answered 403 "org_id
 * required" (proof blitz 2026-10-14). A trusted service caller names the org with x-org-id.
 */
function aghChainOrgId(req) {
  if (req.user && req.user.org_id) return req.user.org_id;
  if (req.service === true) {
    const h = req.headers && req.headers['x-org-id'];
    if (typeof h === 'string' && h.trim()) return h.trim();
  }
  return null;
}

module.exports = { aghChainOrgId };
