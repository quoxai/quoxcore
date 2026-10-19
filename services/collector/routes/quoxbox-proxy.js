/**
 * QuoxBox Proxy Routes
 *
 * Proxies the collector to the QuoxBox governed Mac-mini gateway running on
 * the Docker host (http://172.19.0.1:8877 by default). Mirrors the pattern
 * in services/collector/routes/github-proxy.js:
 * 1. requireAuth() on every route — org-scoped, no anonymous access.
 * 2. All upstream calls happen server-side with a bearer token that never
 *    reaches the browser.
 * 3. Upstream-unreachable is handled gracefully (502 + JSON), never throws.
 *
 * Gateway contract (see ~/quoxbox):
 *   GET  /live                     -> live status, pending approvals, tasks, events
 *   GET  /admin/workflows          -> available governed workflows
 *   POST /task/run                 -> start a task { workflow, params }
 *   GET  /task/:id                 -> task status
 *   POST /admin/approve/:id        -> approve a pending HITL step
 *   POST /admin/deny/:id           -> deny a pending HITL step
 *   POST /admin/mode               -> set gateway mode { mode }
 */

const express = require('express');
const { requireAuth } = require('../utils/httpAuth');
const { gatewayFetch: gatewayFetchImpl } = require('../lib/quoxboxGateway');

const router = express.Router();

const GATEWAY_URL = process.env.QUOXBOX_GATEWAY_URL || 'http://172.19.0.1:8877';
const GATEWAY_TOKEN = process.env.QUOXBOX_GATEWAY_TOKEN || '';

// Apply auth to all routes — org-scoped, no anonymous access.
router.use(requireAuth());

// The gateway fetch (connect probe, remembered outage, named reason) lives in lib/quoxboxGateway.js.
const gatewayFetch = (path, options = {}) => gatewayFetchImpl(path, options, { url: GATEWAY_URL, token: GATEWAY_TOKEN });

/**
 * Forward a gateway response to the Express response, or a 502 if the
 * gateway itself was unreachable.
 */
function relay(res, result) {
  if (result.error && !result.data) {
    console.warn('[QuoxBoxProxy] gateway unreachable:', result.error);
    // retryable:false: a refused or black-holed gateway won't answer on a quick client retry (quox#882).
    return res.status(502).json({ error: 'quoxbox_gateway_unreachable', message: result.error, retryable: false });
  }
  return res.status(result.status || 200).json(result.data ?? {});
}

/**
 * GET /live
 * Live gateway status: mode, screen/capture state, kill-switch, breaker,
 * pending HITL approvals, tasks, evidence chain, event feed.
 */
router.get('/live', async (req, res) => {
  const orgId = req.user?.org_id || null;
  const result = await gatewayFetch('/live');
  relay(res, result);
});

/**
 * GET /workflows
 * Available governed workflows (id, desc, params, steps).
 */
router.get('/workflows', async (req, res) => {
  const result = await gatewayFetch('/admin/workflows');
  relay(res, result);
});

/**
 * POST /task/run
 * Body: { workflow, params }
 */
router.post('/task/run', async (req, res) => {
  const result = await gatewayFetch('/task/run', {
    method: 'POST',
    body: JSON.stringify(req.body || {}),
  });
  relay(res, result);
});

/**
 * GET /task/:id
 */
router.get('/task/:id', async (req, res) => {
  const result = await gatewayFetch(`/task/${encodeURIComponent(req.params.id)}`);
  relay(res, result);
});

/**
 * POST /approve/:id
 */
router.post('/approve/:id', async (req, res) => {
  const result = await gatewayFetch(`/admin/approve/${encodeURIComponent(req.params.id)}`, {
    method: 'POST',
    body: JSON.stringify(req.body || {}),
  });
  relay(res, result);
});

/**
 * POST /deny/:id
 */
router.post('/deny/:id', async (req, res) => {
  const result = await gatewayFetch(`/admin/deny/${encodeURIComponent(req.params.id)}`, {
    method: 'POST',
    body: JSON.stringify(req.body || {}),
  });
  relay(res, result);
});

/**
 * POST /mode
 * Body: { mode: "readonly"|"propose"|"actuate" }
 */
router.post('/mode', async (req, res) => {
  const result = await gatewayFetch('/admin/mode', {
    method: 'POST',
    body: JSON.stringify(req.body || {}),
  });
  relay(res, result);
});

module.exports = router;
