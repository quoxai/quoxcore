/**
 * Facebook plugin dashboard read routes — FB-3 (mirrors LI-OVERHAUL P11).
 *
 * Mounted at /facebook (server.js) behind requireServiceOrUserAuth() +
 * requirePluginEntitlement('facebook'), the same posture as /linkedin.
 *
 * GET /facebook/activity — the org's governed Facebook write history, read
 * from the REAL approval store (tool_approvals): every publish_page_post
 * that was drafted, and whether a human approved, denied, or it errored.
 * This is the evidence surface: the card trail IS the activity ledger, no
 * parallel bookkeeping. Never exposes resume tokens.
 */

const { Router } = require('express');
const toolApprovalStore = require('../lib/toolApprovalStore.js');

const router = Router();

/** JWT org wins; a service caller names it in the query (xRoutes pattern). */
function requireOrgId(req, res) {
  const orgId = req.user?.org_id || (req.service === true ? req.query.org_id : null);
  if (!orgId) {
    res.status(403).json({ success: false, error: 'org_id required' });
    return null;
  }
  return orgId;
}

const STATUS_LABELS = {
  pending: 'awaiting_approval',
  resuming: 'executing',
  approved: 'published',
  denied: 'denied',
  error: 'failed',
};

router.get('/activity', (req, res) => {
  try {
    const orgId = requireOrgId(req, res);
    if (!orgId) return;

    const rows = toolApprovalStore.listRecentByOrg(orgId, {
      toolPrefix: 'facebook_pages_',
      limit: req.query.limit,
    });

    const items = rows.map((r) => {
      let input = {};
      let result = {};
      try { input = r.input_json ? JSON.parse(r.input_json) : {}; } catch { /* keep {} */ }
      try { result = r.result_json ? JSON.parse(r.result_json) : {}; } catch { /* keep {} */ }
      return {
        approval_id: r.approval_id,
        tool: r.tool_name,
        kind: 'post',
        status: STATUS_LABELS[r.status] || r.status,
        text: String(input.message || '').slice(0, 140),
        page_id: input.page_id || null,
        link: input.link || null,
        image_url: input.image_url || null,
        post_id: result.result?.post_id || result.post_id || null,
        permalink: result.result?.permalink || result.permalink || null,
        error: r.status === 'error' ? (result.error || 'execution failed') : (r.status === 'denied' ? (result.reason || null) : null),
        agent_id: r.agent_id || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json({ success: true, org_id: orgId, items });
  } catch (err) {
    console.error('[FacebookRoutes] activity failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read Facebook activity' });
  }
});

module.exports = { router };
