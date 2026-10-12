/**
 * Instagram plugin dashboard read routes — IG-3 (mirrors FB-3 / facebookRoutes.js).
 *
 * Mounted at /instagram (server.js) behind requireServiceOrUserAuth() +
 * requirePluginEntitlement('instagram'), the same posture as /facebook.
 *
 * GET /instagram/activity — the org's governed Instagram write history, read
 * from the REAL approval store (tool_approvals): every publish_media and
 * reply_comment that was drafted, and whether a human approved, denied, or
 * it errored. This is the evidence surface: the card trail IS the activity
 * ledger, no parallel bookkeeping. Never exposes resume tokens.
 *
 * CAUTION: toolPrefix 'instagram_' must never match another connector's
 * tool names. No other connector id starts with 'instagram' (checked against
 * services/collector/lib/connectors/registry.js at review time).
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
      toolPrefix: 'instagram_',
      limit: req.query.limit,
    });

    const items = rows.map((r) => {
      let input = {};
      let result = {};
      try { input = r.input_json ? JSON.parse(r.input_json) : {}; } catch { /* keep {} */ }
      try { result = r.result_json ? JSON.parse(r.result_json) : {}; } catch { /* keep {} */ }
      const kind = r.tool_name === 'instagram_reply_comment' ? 'reply_comment' : 'publish_media';
      return {
        approval_id: r.approval_id,
        tool: r.tool_name,
        kind,
        status: STATUS_LABELS[r.status] || r.status,
        ig_user_id: input.ig_user_id || null,
        caption: kind === 'publish_media' ? String(input.caption || '').slice(0, 140) : null,
        media_type: input.media_type || null,
        image_url: input.image_url || null,
        video_url: input.video_url || null,
        comment_id: kind === 'reply_comment' ? (input.comment_id || null) : null,
        message: kind === 'reply_comment' ? String(input.message || '').slice(0, 140) : null,
        media_id: result.result?.media_id || result.media_id || null,
        permalink: result.result?.permalink || result.permalink || null,
        reply_id: result.result?.reply_id || result.reply_id || null,
        error: r.status === 'error' ? (result.error || 'execution failed') : (r.status === 'denied' ? (result.reason || null) : null),
        agent_id: r.agent_id || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json({ success: true, org_id: orgId, items });
  } catch (err) {
    console.error('[InstagramRoutes] activity failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read Instagram activity' });
  }
});

module.exports = { router };
