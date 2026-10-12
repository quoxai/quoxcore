/**
 * MCP Bundle Route — MCPB-HARDEN Phase 2D
 *
 * POST /api/v1/mcp/bundle
 *
 * Returns a personalised .mcpb archive (zero-config Claude Desktop install)
 * by baking the caller's credentials directly into the bundle manifest.
 *
 * Auth: JWT only (requireAuth). The token to embed in the bundle is passed
 * in the request body — issued by the auth service separately.
 */

'use strict';

const express = require('express');
const JSZip = require('jszip');
const fsPromises = require('fs/promises');
const path = require('path');
const { requireAuth } = require('../utils/httpAuth');

const router = express.Router();

const DEFAULT_BUNDLE_PATH = path.join(__dirname, '..', 'assets', 'quoxmcp.mcpb');

const AGENT_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * Validate and parse a URL string.
 * Returns the URL object on success or null on failure.
 */
function parseUrl(str) {
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

/**
 * POST /
 * Body: { token, collector_url, agent_id? }
 */
router.post('/', requireAuth({ required: true }), async (req, res) => {
  const { token, collector_url, agent_id: rawAgentId } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────────

  if (!token || typeof token !== 'string') {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'token is required and must be a string',
    });
  }

  if (!token.startsWith('qmcp_')) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'token must start with qmcp_',
    });
  }

  if (!collector_url || typeof collector_url !== 'string') {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'collector_url is required and must be a string',
    });
  }

  if (!parseUrl(collector_url)) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'collector_url must be a valid URL',
    });
  }

  const agent_id = rawAgentId !== undefined ? rawAgentId : 'quox';

  if (typeof agent_id !== 'string' || !AGENT_ID_RE.test(agent_id)) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'agent_id must match /^[a-z0-9_-]+$/i',
    });
  }

  // ── Load base bundle ──────────────────────────────────────────────────────

  const bundlePath = process.env.QUOX_MCPB_PATH || DEFAULT_BUNDLE_PATH;

  let bundleBuffer;
  try {
    bundleBuffer = await fsPromises.readFile(bundlePath);
  } catch (err) {
    return res.status(503).json({
      error: 'bundle_not_available',
      message: 'Base bundle not deployed. Set QUOX_MCPB_PATH or deploy services/collector/assets/quoxmcp.mcpb.',
    });
  }

  // ── Generate personalised bundle ──────────────────────────────────────────

  try {
    const zip = await JSZip.loadAsync(bundleBuffer);

    // Read existing manifest
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return res.status(500).json({
        error: 'bundle_generation_failed',
        message: 'Base bundle has no manifest.json',
      });
    }
    const manifestStr = await manifestFile.async('string');
    const baseManifest = JSON.parse(manifestStr);

    // Build personalised manifest
    const newManifest = { ...baseManifest };

    // Ensure server.mcp_config structure exists
    if (!newManifest.server) newManifest.server = {};
    if (!newManifest.server.mcp_config) newManifest.server.mcp_config = {};

    newManifest.server = {
      ...newManifest.server,
      mcp_config: {
        ...newManifest.server.mcp_config,
        env: {
          QUOX_COLLECTOR_URL: collector_url,
          QUOX_SERVICE_KEY: token,
          QUOX_AGENT_ID: agent_id,
          QUOX_ORG_ID: req.user.org_id,
          QUOX_USER_ID: req.user.id,
        },
      },
    };

    // Remove user_config — it's now baked in above
    delete newManifest.user_config;

    // Replace manifest in zip
    zip.file('manifest.json', JSON.stringify(newManifest, null, 2));

    // Generate personalised zip
    const outputBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="quoxmcp-personalised.mcpb"');
    return res.send(outputBuffer);
  } catch (err) {
    console.error('[MCPB-HARDEN] bundle generation failed:', err);
    return res.status(500).json({
      error: 'bundle_generation_failed',
      message: err.message,
    });
  }
});

module.exports = router;
