/**
 * LinkedIn plugin dashboard read routes — LI-OVERHAUL P11.
 *
 * Mounted at /linkedin (server.js) behind requireServiceOrUserAuth() +
 * requirePluginEntitlement('linkedin'), the same posture as the /x mount.
 *
 * GET /linkedin/activity — the org's governed LinkedIn write history, read
 * from the REAL approval store (tool_approvals): every publish/comment that
 * was drafted, and whether a human approved, denied, or it errored. This is
 * the evidence surface: the card trail IS the activity ledger, no parallel
 * bookkeeping. Never exposes resume tokens.
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
      toolPrefix: 'linkedin_',
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
        kind: r.tool_name === 'linkedin_create_comment' ? 'comment' : 'post',
        status: STATUS_LABELS[r.status] || r.status,
        text: String(input.text || '').slice(0, 140),
        author: input.author || input.actor || null,
        post_urn: result.result?.post_urn || result.post_urn || null,
        comment_id: result.result?.comment_id || null,
        error: r.status === 'error' ? (result.error || 'execution failed') : (r.status === 'denied' ? (result.reason || null) : null),
        agent_id: r.agent_id || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json({ success: true, org_id: orgId, items });
  } catch (err) {
    console.error('[LinkedInRoutes] activity failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read LinkedIn activity' });
  }
});

module.exports = { router };
