/**
 * TikTok plugin dashboard read routes — TT-4 (mirrors IG-3 / instagramRoutes.js).
 *
 * Mounted at /tiktok (server.js) behind requireServiceOrUserAuth() +
 * requirePluginEntitlement('tiktok'), the same posture as /instagram.
 *
 * GET /tiktok/activity — the org's governed TikTok write history, read from
 * the REAL approval store (tool_approvals): every publish_video and
 * upload_draft that was drafted, and whether a human approved, denied, or it
 * errored. This is the evidence surface: the card trail IS the activity
 * ledger, no parallel bookkeeping. Never exposes resume tokens or file paths
 * beyond the basename already shown on the card.
 *
 * CAUTION: toolPrefix 'tiktok_' must never match another connector's tool
 * names. No other connector id starts with 'tiktok' (checked against
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
      toolPrefix: 'tiktok_',
      limit: req.query.limit,
    });

    const items = rows.map((r) => {
      let input = {};
      let result = {};
      try { input = r.input_json ? JSON.parse(r.input_json) : {}; } catch { /* keep {} */ }
      try { result = r.result_json ? JSON.parse(r.result_json) : {}; } catch { /* keep {} */ }
      const kind = r.tool_name === 'tiktok_upload_draft' ? 'upload_draft' : 'publish_video';
      return {
        approval_id: r.approval_id,
        tool: r.tool_name,
        kind,
        status: STATUS_LABELS[r.status] || r.status,
        title: String(input.title || '').slice(0, 140) || null,
        privacy_level: kind === 'publish_video' ? (input.privacy_level || 'SELF_ONLY') : null,
        file: input.video_path ? String(input.video_path).split('/').pop() : null,
        publish_id: result.result?.publish_id || result.publish_id || null,
        note: result.result?.note || result.note || null,
        error: r.status === 'error' ? (result.error || 'execution failed') : (r.status === 'denied' ? (result.reason || null) : null),
        agent_id: r.agent_id || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    res.json({ success: true, org_id: orgId, items });
  } catch (err) {
    console.error('[TikTokRoutes] activity failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read TikTok activity' });
  }
});

module.exports = { router };
